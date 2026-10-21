import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { describe, expect, test } from 'vitest';
import { canonicalDocument, parseAuthorityJson, type CanonicalJsonValue } from '../../src/services/admission/canonical-json';
import { createGenesisEntry, deriveManifestAppend, verifyManifestPrefix, verifyManifestPrefixCarrier, type DetachedRecordCandidate, type IndependentRecordReviewV1 } from '../../src/services/admission/evidence-spine-manifest';
import type { ArtifactEvidenceRecordV1, BlindGradePacketBodyV1, BlindGraderMaterialV1, EvidenceRecordV1, EvidenceSpineRootV1, ExternalBlindMappingCommitmentCarrierV1, ExternalBrandingAssessmentCarrierV1, FrozenBlindGradePacketV1, GradeEvidenceRecordV1, IndependentReviewV1, PreparedBlindGradeCandidateV1, SourceReceiptRefV1, VerifiedActiveGradeInputCarrierV1, VerifiedGradeOutputCarrierV1, VerifiedGradeRubricCarrierV1, VerifiedManifestPrefixCarrierV1 } from '../../src/services/admission/evidence-spine-types';
import { contentIdentity, recordSha256, type ContentIdentity } from '../../src/services/admission/identity';
import { verifyIntegrationReceiptResolutionCarrier, type NonPassingObservation, type ReceiptResolution } from '../../src/services/admission/product-receipts';
import { validateEvidenceRecord } from '../../src/services/admission/evidence-spine-validation';
import type * as BlindGradeAdapterModule from '../../src/services/admission/blind-grade-adapter';

/** Offline synthetic-local RED fixture. It creates no evidence or side effect. */
type Obj = Record<string, unknown>;
const adapterPath = resolve(process.cwd(), 'src/services/admission/blind-grade-adapter.ts');
const typesPath = resolve(process.cwd(), 'src/services/admission/evidence-spine-types.ts');
const barrelPath = resolve(process.cwd(), 'src/services/admission/evidence-spine.ts');
const encoder = new TextEncoder();
const asJson = (value: unknown): CanonicalJsonValue => value as CanonicalJsonValue;
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
const fakeIdentity = (digit: string, byteLength = 1): ContentIdentity => ({ byte_length: byteLength, sha256: digit.repeat(64) });
const refsSorted = <T extends SourceReceiptRefV1>(values: readonly T[]): T[] => [...values].sort((left, right) => `${left.receipt_kind}\0${left.receipt_id}`.localeCompare(`${right.receipt_kind}\0${right.receipt_id}`));
const stringsSorted = (values: readonly string[]): string[] => [...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

type AdapterModuleCensus = Readonly<{
  identifiers: ReadonlySet<string>;
  runtimeBindings: readonly string[];
  unapprovedRuntimeBindings: readonly string[];
  moduleStateBindings: readonly string[];
  unsupportedTopLevelStatements: readonly string[];
  dynamicImportCount: number;
  forbiddenMutationCalls: readonly string[];
  faultEnd: number;
}>;

const approvedAdapterRuntimeBindings = [
  'canonical', 'encoder', 'LINK_FIELD', 'ID_KEYS', 'GRADE_REASONS', 'VERDICTS', 'FORBIDDEN', 'FORBIDDEN_MARKDOWN',
] as const;

function acceptsAdapterModuleCensus(census: AdapterModuleCensus): boolean {
  return census.runtimeBindings.length === approvedAdapterRuntimeBindings.length
    && census.runtimeBindings.every((binding, index) => binding === approvedAdapterRuntimeBindings[index])
    && census.unapprovedRuntimeBindings.length === 0
    && census.moduleStateBindings.length === 0
    && census.unsupportedTopLevelStatements.length === 0
    && census.dynamicImportCount === 0
    && census.forbiddenMutationCalls.length === 0
    && census.faultEnd > 0;
}

/** Parse every mutation in an isolated virtual project; no module is executed or written. */
function withAdapterModuleCensus(inspect: (census: (source: string) => AdapterModuleCensus) => void): void {
  const directory = resolve(process.cwd(), '__task5_in_memory__').replaceAll('\\', '/');
  const configPath = `${directory}/tsconfig.json`;
  const filePath = `${directory}/adapter.ts`;
  const files = {
    [configPath]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true }, files: ['adapter.ts'] }),
    [filePath]: '',
  };
  const virtualFiles = createVirtualFileSystem(files);
  const api = new API({ cwd: directory, fs: { ...virtualFiles, readFile: (path) =>
    path.replaceAll('\\', '/').toLowerCase() === filePath.toLowerCase() ? files[filePath] : virtualFiles.readFile!(path) } });
  try {
    inspect((source) => {
      files[filePath] = source;
      api.clearSourceFileCache();
      const snapshot = api.updateSnapshot({ openProjects: [configPath], fileChanges: { invalidateAll: true } });
      try {
        const program = snapshot.getProject(configPath)!.program;
        expect(program.getSyntacticDiagnostics(filePath)).toEqual([]);
        const file = program.getSourceFile(filePath)!;
        expect(file.text).toBe(source);
        return analyzeAdapterAst(file);
      } finally { snapshot.dispose(); }
    });
  } finally { api.close(); }
}

function analyzeAdapterAst(file: ts.SourceFile): AdapterModuleCensus {
  const identifiers = new Set<string>();
  const runtimeBindings: string[] = [];
  const unapprovedRuntimeBindings: string[] = [];
  const moduleStateBindings: string[] = [];
  const unsupportedTopLevelStatements: string[] = [];
  const forbiddenMutationCalls: string[] = [];
  let dynamicImportCount = 0;
  let faultEnd = -1;
  const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
    visit(node);
    node.forEachChild((child) => { walk(child, visit); });
  };
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(node) || ts.isAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
  };
  const isIife = (node: ts.Node): boolean => {
    let expression = node;
    while (ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent)) expression = expression.parent;
    return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
  };
  // An IIFE inherits its caller's lifetime. Nested callbacks belong to their outer
  // invocation; merely adding function braces cannot make initialization state local.
  const owner = (node: ts.Node): ts.Node => {
    let result: ts.Node = file;
    for (let current = node; current && current !== file; current = current.parent) {
      if (ts.isFunctionLikeDeclaration(current) && !isIife(current)) result = current;
    }
    return result;
  };
  const scope = (node: ts.Node): ts.Node => {
    while (node !== file && !ts.isBlock(node) && !ts.isFunctionLikeDeclaration(node) && !ts.isClassLikeDeclaration(node)) node = node.parent;
    return node;
  };
  type Binding = { owner: ts.Node; declaration: ts.Node; values: ts.Expression[] };
  const bindings = new Map<ts.Node, Map<string, Binding>>();
  let sourceNodeCount = 0;
  const bind = (name: ts.BindingName, node: ts.Node, location: ts.Node, initializer?: ts.Expression): void => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element) && element.name) bind(element.name, node, location, initializer);
      return;
    }
    const entries = bindings.get(location) ?? new Map<string, Binding>();
    entries.set(name.text, { owner: owner(node.parent), declaration: node, values: initializer ? [initializer] : [] });
    bindings.set(location, entries);
  };
  walk(file, (node) => {
    sourceNodeCount += 1;
    if (ts.isVariableDeclaration(node)) {
      const lexicalScope = ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)
        ? owner(node) : scope(node.parent);
      bind(node.name, node, lexicalScope, node.initializer);
    } else if (ts.isParameterDeclaration(node) && node.name) bind(node.name, node, scope(node.parent), node.initializer);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) bind(node.name, node, scope(node.parent));
  });
  const bindingOf = (node: ts.Identifier): Binding | undefined => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      const binding = bindings.get(current)?.get(node.text);
      if (binding) return binding;
    }
    return undefined;
  };
  // Join assignment origins conservatively; a later overwrite must not hide a
  // module/class alias behind an initially fresh local container.
  walk(file, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
      bindingOf(node.left)?.values.push(node.right);
    }
  });
  const sharedTarget = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const node = unwrap(expression);
    if (seen.has(node)) return true; // An unresolved alias cycle cannot prove confinement.
    seen.add(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return sharedTarget(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const binding = bindingOf(node);
      if (!binding || binding.owner === file) return true;
      return binding.values.some((value) => sharedTarget(value, new Set(seen)));
    }
    if (ts.isConditionalExpression(node)) return sharedTarget(node.whenTrue, new Set(seen)) || sharedTarget(node.whenFalse, new Set(seen));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      return sharedTarget(node.left, new Set(seen)) || sharedTarget(node.right, new Set(seen));
    }
    // A call result is not provably fresh without interprocedural authority.
    if (ts.isCallExpression(node)) return true;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      for (let current = node.parent; current && current !== file; current = current.parent) {
        if (ts.isConstructorDeclaration(current)) return false;
        if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
          return !!current.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
        }
      }
      return true;
    }
    return false;
  };
  const sharedWrite = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    // Rebinding a local alias changes its local slot, not the referenced object.
    return ts.isIdentifier(node) ? !bindingOf(node) || bindingOf(node)!.owner === file : sharedTarget(node);
  };
  const allocationName = (node: ts.Node): string => {
    for (let current = node.parent; current && current !== file; current = current.parent) {
      if (ts.isVariableDeclaration(current)) return current.name.getText(file);
      if (ts.isFunctionLikeDeclaration(current)) break;
    }
    return `allocation@${node.getStart(file)}`;
  };
  const literalData = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    return ts.isStringLiteral(node) || (ts.isArrayLiteralExpression(node) && node.elements.every((element) =>
      ts.isStringLiteral(element) || (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)
        && approvedAdapterRuntimeBindings.includes(element.expression.text as typeof approvedAdapterRuntimeBindings[number]))));
  };
  const approvedDataTable = (node: ts.ArrayLiteralExpression): boolean => {
    let expression: ts.Node = node;
    while (ts.isAssertionExpression(expression.parent) || ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
    const declaration = expression.parent;
    return ts.isVariableDeclaration(declaration) && scope(declaration.parent) === file
      && ['ID_KEYS', 'GRADE_REASONS', 'VERDICTS', 'FORBIDDEN', 'FORBIDDEN_MARKDOWN'].includes(declaration.name.getText(file))
      && literalData(node);
  };
  // Property reads can execute getters without a CallExpression. Follow their
  // returned values and lexical aliases, then inspect only storage that escapes
  // in the retained value. A retained function's own locals remain per-call.
  const within = (node: ts.Node, ancestor: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true;
    return false;
  };
  const returnedValues = (getter: ts.GetAccessorDeclaration): ts.Expression[] => {
    const values: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (node !== getter && ts.isFunctionLikeDeclaration(node)) return;
      if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
      node.forEachChild(visit);
    };
    visit(getter);
    return values;
  };
  const propertyKeys = (name: ts.PropertyName, seen: Set<ts.Node>): string[] => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return [name.text];
    return ts.isComputedPropertyName(name) ? valueSources(name.expression, seen)
      .filter((value) => ts.isStringLiteral(value) || ts.isNumericLiteral(value)).map((value) => value.text) : [];
  };
  let remainingValueSteps = 0;
  const valueSources = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Node[] => {
    // Bound alias/branch expansion by the source's node count per initializer.
    // Cycles or exhausted resolution cannot establish confinement.
    if (--remainingValueSteps < 0) {
      if (remainingValueSteps === -1) moduleStateBindings.push('value-flow-budget');
      return [];
    }
    const node = unwrap(expression);
    if (seen.has(node)) {
      moduleStateBindings.push(`value-cycle:${node.getStart(file)}`);
      return [];
    }
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const binding = bindingOf(node);
      if (!binding) return [node]; // Imported pure references are not local storage.
      if (ts.isFunctionDeclaration(binding.declaration) || ts.isClassDeclaration(binding.declaration)) return [binding.declaration];
      return binding.values.flatMap((value) => valueSources(value, next));
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      for (let current = node.parent; current && current !== file; current = current.parent) {
        if (ts.isClassLikeDeclaration(current)) return [current];
      }
    }
    if (ts.isConditionalExpression(node)) return [...valueSources(node.whenTrue, next), ...valueSources(node.whenFalse, next)];
    if (ts.isBinaryExpression(node)) {
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        return [...valueSources(node.left, next), ...valueSources(node.right, next)];
      }
      if (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return valueSources(node.right, next);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : valueSources(node.argumentExpression, next)
        .filter((value) => ts.isStringLiteral(value) || ts.isNumericLiteral(value)).map((value) => value.text);
      return valueSources(node.expression, next).flatMap((receiver) => {
        const members = ts.isClassLikeDeclaration(receiver) ? receiver.members.filter((member): member is
          ts.PropertyDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
          (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
          && !!member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
          : ts.isObjectLiteralExpression(receiver) ? receiver.properties : [];
        return members.flatMap((member): ts.Node[] => {
          if (!('name' in member) || !member.name || !propertyKeys(member.name, next).some((key) => keys.includes(key))) return [];
          if (ts.isGetAccessorDeclaration(member)) return returnedValues(member).flatMap((value) => valueSources(value, next));
          if ((ts.isPropertyDeclaration(member) || ts.isPropertyAssignment(member)) && member.initializer) return valueSources(member.initializer, next);
          if (ts.isShorthandPropertyAssignment(member) && ts.isIdentifier(member.name)) return valueSources(member.name, next);
          return ts.isMethodDeclaration(member) ? [member] : [];
        });
      });
    }
    return [node];
  };
  const inspectRetained = (value: ts.Node, label: string, seen: Set<ts.Node>): void => {
    if (seen.has(value)) return; // Each value/capture is inspected at most once per read.
    seen.add(value);
    if (ts.isFunctionLikeDeclaration(value)) {
      walk(value, (node) => {
        if (!ts.isIdentifier(node)) return;
        const parent = node.parent;
        if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return;
        const binding = bindingOf(node);
        if (!binding || binding.owner === file || within(binding.declaration, value)) return;
        for (const origin of valueSources(node)) inspectRetained(origin, node.text, seen);
      });
    } else if (!ts.isIdentifier(value) && !ts.isClassLikeDeclaration(value)) {
      // Objects/collections and captured scalar/symbol/call results all represent
      // retained storage, regardless of a registry/cache/token/brand spelling.
      moduleStateBindings.push(`retained:${label}:${ts.SyntaxKind[value.kind]}`);
    }
  };
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(file);
        runtimeBindings.push(name);
        if (!approvedAdapterRuntimeBindings.includes(name as typeof approvedAdapterRuntimeBindings[number])) unapprovedRuntimeBindings.push(name);
      }
    } else if (ts.isClassDeclaration(statement) && statement.name?.text === 'Fault') faultEnd = statement.end;
    else if (!ts.isImportDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)
      && !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement) && !ts.isEmptyStatement(statement)) {
      unsupportedTopLevelStatements.push(ts.SyntaxKind[statement.kind]);
    }
  }
  walk(file, (node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    const shared = owner(node) === file;
    if (ts.isVariableDeclaration(node) && shared && scope(node.parent) !== file) {
      moduleStateBindings.push(`${node.name.getText(file)}:shared-initialization`);
    }
    if (ts.isVariableDeclaration(node) && shared && ts.isVariableDeclarationList(node.parent)
      && !(node.parent.flags & ts.NodeFlags.Const)) moduleStateBindings.push(`${node.name.getText(file)}:mutable`);
    if (ts.isNewExpression(node) && shared) {
      const name = allocationName(node);
      if (!(name === 'encoder' && ts.isIdentifier(node.expression) && node.expression.text === 'TextEncoder'
        && !node.arguments?.length && ts.isVariableDeclaration(node.parent) && scope(node.parent) === file)) {
        moduleStateBindings.push(`${name}:${node.expression.getText(file)}`);
      }
    }
    if (ts.isObjectLiteralExpression(node) && shared) moduleStateBindings.push(`${allocationName(node)}:object`);
    if (ts.isArrayLiteralExpression(node) && shared && !approvedDataTable(node)) moduleStateBindings.push(`${allocationName(node)}:array`);
    if (ts.isClassStaticBlockDeclaration(node)) moduleStateBindings.push(`static-block:${ts.isClassLikeDeclaration(node.parent) ? node.parent.name?.text : 'anonymous'}`);
    if (ts.isPropertyDeclaration(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
      moduleStateBindings.push(`static:${ts.isClassLikeDeclaration(node.parent) ? node.parent.name?.text : 'anonymous'}:${node.name.getText(file)}`);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && sharedWrite(node.left)) moduleStateBindings.push(`write:${node.left.getText(file)}`);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && sharedWrite(node.operand)) moduleStateBindings.push(`update:${node.operand.getText(file)}`);
    if (ts.isDeleteExpression(node) && sharedTarget(node.expression)) moduleStateBindings.push(`delete:${node.expression.getText(file)}`);
    if (shared && ts.isVariableDeclaration(node) && node.initializer) {
      remainingValueSteps = sourceNodeCount;
      const seen = new Set<ts.Node>();
      for (const value of valueSources(node.initializer)) {
        // Existing allocation rules own direct initializers (including the
        // approved encoder/tables); this pass owns values reached indirectly.
        if (value !== unwrap(node.initializer) || ts.isFunctionLikeDeclaration(value)) inspectRetained(value, node.name.getText(file), seen);
      }
    }
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) dynamicImportCount += 1;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (callee.expression.getText(file) === 'Object' && ['defineProperty', 'setPrototypeOf'].includes(method)) forbiddenMutationCalls.push(`Object.${method}`);
      if (['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].includes(method)
        && sharedTarget(callee.expression)) moduleStateBindings.push(`mutate:${callee.getText(file)}`);
      if (callee.expression.getText(file) === 'Object' && method === 'assign' && node.arguments[0]
        && sharedTarget(node.arguments[0])) moduleStateBindings.push('mutate:Object.assign');
    }
    if (shared && !ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) {
      moduleStateBindings.push(`${allocationName(node)}:${callee.getText(file)}`);
    }
  });
  return {
    identifiers, runtimeBindings, unapprovedRuntimeBindings, moduleStateBindings,
    unsupportedTopLevelStatements, dynamicImportCount, forbiddenMutationCalls, faultEnd,
  };
}

function jsonObject(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EXPECTED_JSON_OBJECT');
  return Object.fromEntries<unknown>(Object.entries(value));
}

function identityFromJson(value: unknown): ContentIdentity {
  const item = jsonObject(value);
  if (!Number.isSafeInteger(item.byte_length) || (item.byte_length as number) < 0 || typeof item.sha256 !== 'string') throw new Error('EXPECTED_CONTENT_IDENTITY');
  return { byte_length: item.byte_length as number, sha256: item.sha256 };
}

function stringArrayFromJson(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('EXPECTED_STRING_ARRAY');
  return [...value];
}

function gradeMaterialFromJson(value: unknown): BlindGraderMaterialV1 {
  const item = jsonObject(value);
  if (item.schemaVersion !== 'MES-BLIND-GRADER-MATERIAL-1' || (item.slotId !== 'SLOT_1' && item.slotId !== 'SLOT_2')
    || typeof item.redactedMaterialBytesBase64 !== 'string') throw new Error('EXPECTED_GRADER_MATERIAL');
  return {
    schemaVersion: item.schemaVersion,
    slotId: item.slotId,
    rootIdentity: identityFromJson(item.rootIdentity),
    gradeMaterialSetIdentity: identityFromJson(item.gradeMaterialSetIdentity),
    stateDescriptorIdentity: identityFromJson(item.stateDescriptorIdentity),
    redactedMaterialBytesBase64: item.redactedMaterialBytesBase64,
    redactedMaterialIdentity: identityFromJson(item.redactedMaterialIdentity),
    unavoidableDisclosureTokens: stringArrayFromJson(item.unavoidableDisclosureTokens),
  };
}

function requireGradeInputRecord(record: EvidenceRecordV1): ArtifactEvidenceRecordV1 {
  if (record.record_family !== 'ARTIFACT' || record.payload.kind !== 'GRADE_INPUT') throw new Error('EXPECTED_GRADE_INPUT_RECORD');
  return record;
}

function requireGradeRecord(record: EvidenceRecordV1): GradeEvidenceRecordV1 {
  if (record.record_family !== 'GRADE') throw new Error('EXPECTED_GRADE_RECORD');
  return record;
}

async function doc(value: unknown): Promise<Readonly<{ bytes: Uint8Array; identity: ContentIdentity }>> {
  const bytes = canonicalDocument(asJson(value));
  return Object.freeze({ bytes, identity: await contentIdentity(bytes) });
}

async function pending(builder: string): Promise<IndependentReviewV1> {
  return {
    builder_identity: builder, reviewer_identity: 'UNKNOWN', separation: 'UNKNOWN',
    review_output_identity: (await doc({ schema_version: 'MES-REVIEW-PENDING-1' })).identity,
    verdict: 'UNKNOWN', vendor_family: 'UNKNOWN',
  } as const;
}

async function makeTarget(subject: ContentIdentity, account: ContentIdentity, includeFourthResolvedReceipt = false) {
  const buildIdentity = (await doc({ fixture: 'build' })).identity;
  const deploymentIdentity = (await doc({ fixture: 'deployment' })).identity;
  const routeManifestIdentity = (await doc({ fixture: 'route' })).identity;
  const controlPlaneIdentity = (await doc({ fixture: 'control' })).identity;
  const payloads: Obj[] = [
    { receiptKind: 'BUILD', subjectIdentity: subject, accountScopeIdentity: account, causal: { buildIdentity } },
    { receiptKind: 'CONTROL_PLANE', subjectIdentity: subject, accountScopeIdentity: account, causal: { deploymentIdentity, routeManifestIdentity, controlPlaneIdentity } },
    { receiptKind: 'DEPLOYMENT', subjectIdentity: subject, accountScopeIdentity: account, causal: { buildIdentity, deploymentIdentity } },
  ];
  if (includeFourthResolvedReceipt) {
    payloads.push({
      receiptKind: 'ACCESSIBILITY', subjectIdentity: subject, accountScopeIdentity: account,
      causal: {
        controlId: 'fixture-accessibility-control', encryptedContainerIdentity: fakeIdentity('8', 18),
        policyIdentity: fakeIdentity('9', 19), targetLink: { fixture: 'target-link' },
      },
    });
  }
  const refs: SourceReceiptRefV1[] = [];
  for (const payload of payloads) {
    const receiptKind = payload.receiptKind;
    if (typeof receiptKind !== 'string') throw new Error('FIXTURE_TARGET_RECEIPT_KIND');
    refs.push({ receipt_kind: receiptKind as SourceReceiptRefV1['receipt_kind'], receipt_id: `receipt-${receiptKind.toLowerCase()}`, content_identity: (await doc(payload)).identity });
  }
  const sorted = refsSorted(refs);
  return {
    buildIdentity, deploymentIdentity, routeManifestIdentity, controlPlaneIdentity, payloads,
    refs: sorted,
    targetRefs: sorted.filter((ref) => ref.receipt_kind === 'BUILD' || ref.receipt_kind === 'CONTROL_PLANE' || ref.receipt_kind === 'DEPLOYMENT'),
  } as const;
}

function resolution(ref: SourceReceiptRefV1, payload: Obj, subject: ContentIdentity, marker: string): Obj {
  return {
    ref, subjectIdentity: subject, committedAt: '2026-09-05T00:00:00.000Z', privacy: 'ENCRYPTED_PRIVATE_CONTAINER',
    integrityProof: {
      proofKind: 'COMMITTED_EXTERNAL_CONTAINER', protectedSubjectIdentity: subject,
      containerIdentity: fakeIdentity(marker, 11), policyIdentity: fakeIdentity(marker === 'a' ? 'b' : 'a', 12), independentReadbackIdentity: fakeIdentity(marker === 'c' ? 'd' : 'c', 13),
    },
    canonicalBytesBase64: b64(canonicalDocument(asJson(payload))), payload,
  };
}

async function artifact(input: Readonly<{
  label: string; rootIdentity: ContentIdentity; subject: ContentIdentity; target: Awaited<ReturnType<typeof makeTarget>>;
  redactedIdentity: ContentIdentity; builder: string; vendor: string;
}>) {
  const scope = { purpose_identity: fakeIdentity('1', 21), subject_identity: input.subject, time_identity: fakeIdentity('2', 22), environment_identity: input.target.controlPlaneIdentity, exclusion_identities: [] };
  const body: Obj = {
    schema_version: 'MES-1', record_family: 'ARTIFACT', record_id: '0'.repeat(64), root_identity: input.rootIdentity, evidence_key: 'pending-key',
    subject_identity: { subject_type: 'fixture-subject', subject_key: 'synthetic-local', content_identity: input.subject }, created_at: '2026-09-05T00:00:00.000Z',
    producer_identity: { producer_id: input.builder, role: 'BUILDER', vendor_family: input.vendor, attestation: 'SYNTHETIC_LOCAL_ONLY' },
    source_receipts: input.target.refs, limitations: ['synthetic-local fixture'], independent_review: await pending(input.builder),
    payload: {
      id: `artifact-${input.label}`, slice_id: 'N0', evidence_requirement_ids: ['N0-D1'], gate: 'D', kind: 'GRADE_INPUT', path_or_url: `repo://fixture/${input.label}`,
      sha256: input.redactedIdentity.sha256, captured_at: '2026-09-05T00:00:00.000Z', evidence_label: 'CODE_VERIFIED', outcome: 'CLAIM_SUPPORTED', status: 'PASS', scope, limitations: [],
      bindings: {
        source_receipts: input.target.refs, build_identity: input.target.buildIdentity, deployment_identity: input.target.deploymentIdentity, account_scope_identity: null,
        capture_environment_identity: input.target.controlPlaneIdentity, retention_policy_identity: null, access_policy_identity: null, negative_control_result_ids: [], failure_tell_observations: [], claim_assertions: [],
        kind_details: { kind: 'GRADE_INPUT', presentation_packet_id: `presentation-${input.label}`, randomized_mapping_commitment: 'f'.repeat(64), presented_artifact_ids: [`artifact-${input.label}`], same_state_material: true },
      },
    },
  };
  body.evidence_key = await recordSha256(asJson({ schema_version: 'MES-EVIDENCE-KEY-1', record_family: 'ARTIFACT', root_identity: input.rootIdentity, artifact_kind: 'GRADE_INPUT', subject_identity: body.subject_identity, requirement_ids: ['N0-D1'] }));
  const { record_id: _discarded, ...withoutId } = body;
  body.record_id = await recordSha256(asJson(withoutId));
  const record = requireGradeInputRecord(validateEvidenceRecord(body));
  const bytes = canonicalDocument(asJson(record));
  return Object.freeze({ candidate: Object.freeze({ record, canonical_bytes: bytes, record_identity: await contentIdentity(bytes) }), scope });
}

async function review(candidate: DetachedRecordCandidate) {
  const body = {
    schema_version: 'MES-REVIEW-1', root_identity: candidate.record.root_identity, candidate_identity: candidate.record_identity,
    builder_identity: candidate.record.producer_identity.producer_id, builder_vendor_family: candidate.record.producer_identity.vendor_family,
    reviewer_identity: 'offline-reviewer', reviewer_vendor_family: 'INDEPENDENT_VENDOR', separation: 'VERIFIED', verdict: 'ADMIT', reason_codes: [],
  } as const;
  return { body, ...(await doc(body)) };
}

function blob(bytes: Uint8Array, identity: ContentIdentity) { return { bytesBase64: b64(bytes), contentIdentity: identity }; }

async function prefixFor(rootIdentity: ContentIdentity, candidates: readonly DetachedRecordCandidate[]) {
  const genesis = createGenesisEntry(rootIdentity);
  const genesisDoc = await doc(genesis);
  let prefix = await verifyManifestPrefix(rootIdentity, [genesis]);
  const packets: Obj[] = [{ entry: blob(genesisDoc.bytes, genesisDoc.identity), candidate: null, review: null, correctionAuthority: null, correctionReviews: [] }];
  for (const candidate of candidates) {
    const admitted = await review(candidate);
    const append = await deriveManifestAppend({
      prefix, expectedHead: prefix.head_identity!, candidate,
      review: { review: admitted.body, canonical_bytes: admitted.bytes, review_identity: admitted.identity, correction_authority: null, correction_reviews: [] } as IndependentRecordReviewV1,
    });
    if (!append.proposedEntry || append.proposedPrefix.head_identity === null) throw new Error('FIXTURE_PREFIX_APPEND_FAILED');
    const entry = await doc(append.proposedEntry);
    packets.push({ entry: blob(entry.bytes, entry.identity), candidate: blob(candidate.canonical_bytes, candidate.record_identity), review: blob(admitted.bytes, admitted.identity), correctionAuthority: null, correctionReviews: [] });
    prefix = append.proposedPrefix;
  }
  const carrier = { schemaVersion: 'MES-MANIFEST-PREFIX-CARRIER-1', rootIdentity, packets };
  const settled = await doc(carrier);
  const verified = await verifyManifestPrefixCarrier(rootIdentity, prefix.head_identity!, settled.bytes, settled.identity);
  if (!verified) throw new Error('FIXTURE_PREFIX_REVERIFY_FAILED');
  return Object.freeze({ carrier, ...settled, headIdentity: prefix.head_identity!, verified });
}

async function targetCarrier(root: EvidenceSpineRootV1, rootIdentity: ContentIdentity, candidate: DetachedRecordCandidate, target: Awaited<ReturnType<typeof makeTarget>>, subject: ContentIdentity) {
  const carrier = {
    schemaVersion: 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1', rootIdentity, candidateIdentity: candidate.record_identity,
    resolutions: target.refs.map((ref) => {
      const payload = target.payloads.find((item) => item.receiptKind === ref.receipt_kind);
      if (!payload) throw new Error('FIXTURE_TARGET_RECEIPT_MISSING');
      return resolution(ref, payload, subject, ref.receipt_kind === 'BUILD' ? 'a' : ref.receipt_kind === 'CONTROL_PLANE' ? 'c' : 'e');
    }),
  };
  const settled = await doc(carrier);
  const verified = await verifyIntegrationReceiptResolutionCarrier(root, candidate, settled.bytes, settled.identity);
  if (!verified) throw new Error('FIXTURE_TARGET_RECEIPT_REVERIFY_FAILED');
  return Object.freeze({ carrier, ...settled, verified });
}

async function deriveOutputBootstrapCandidate(input: Readonly<{
  rootIdentity: ContentIdentity; subject: ContentIdentity; target: Awaited<ReturnType<typeof makeTarget>>;
  packetIdentity: ContentIdentity; rubricIdentity: ContentIdentity; matrixIdentity: ContentIdentity;
  mappingIdentity: ContentIdentity; outputIdentity: ContentIdentity; output: Obj;
}>) {
  const output = input.output as Obj;
  const grader = output.grader as Obj;
  const gradeOutputPayload = {
    receiptKind: 'GRADE_OUTPUT', subjectIdentity: input.subject, accountScopeIdentity: (await doc({ fixture: 'account' })).identity,
    causal: {
      packetIdentity: input.packetIdentity,
      graderIdentity: (await doc({ reviewerIdentity: grader.reviewerIdentity, modelIdentity: grader.modelIdentity })).identity,
      graderFamily: grader.vendorFamily,
      verdict: output.verdict,
      reasonCodes: output.reasonCodes,
    },
  };
  const outputRef = { receipt_kind: 'GRADE_OUTPUT' as const, receipt_id: 'receipt-grade-output', content_identity: (await doc(gradeOutputPayload)).identity };
  const sourceReceipts = refsSorted([...input.target.refs, outputRef]);
  const gradeRunId = `GRADE:${input.packetIdentity.sha256}:${input.outputIdentity.sha256}`;
  const evidenceKey = await recordSha256(asJson({ schema_version: 'MES-EVIDENCE-KEY-1', record_family: 'GRADE', root_identity: input.rootIdentity, grade_run_id: gradeRunId }));
  const payload: Obj = {
    id: gradeRunId, slice_ids: ['N0'], frozen_rubric_sha256: input.rubricIdentity.sha256,
    matrix_sha256: input.matrixIdentity.sha256, artifact_ids: ['artifact-one', 'artifact-two'], builder_vendor_family: 'BUILDER_VENDOR_ONE',
    grader_vendor_family: grader.vendorFamily, grader_is_non_builder: true, builder_report_used: false, branding_treatment: 'STRIPPED',
    same_state_material: true, mapping_commitment: input.mappingIdentity.sha256, prompt_sha256: input.packetIdentity.sha256,
    verdict: output.verdict, reasons: output.reasonCodes, unassessable_dimensions: output.unassessableDimensions,
    timestamp: '2026-09-05T00:00:00.000Z', output_sha256: input.outputIdentity.sha256,
  };
  const body: Obj = {
    schema_version: 'MES-1', record_family: 'GRADE', record_id: '0'.repeat(64), root_identity: input.rootIdentity,
    evidence_key: evidenceKey,
    subject_identity: { subject_type: 'fixture-subject', subject_key: 'synthetic-local', content_identity: input.subject }, created_at: '2026-09-05T00:00:00.000Z',
    producer_identity: { producer_id: (grader.modelIdentity as ContentIdentity).sha256, role: 'INDEPENDENT_GRADER', vendor_family: grader.vendorFamily, attestation: (grader.independenceReceiptIdentity as ContentIdentity).sha256 },
    source_receipts: sourceReceipts, limitations: ['synthetic-local fixture'], independent_review: await pending((grader.modelIdentity as ContentIdentity).sha256), payload,
  };
  const { record_id: _discarded, ...withoutId } = body;
  body.record_id = await recordSha256(asJson(withoutId));
  const record = requireGradeRecord(validateEvidenceRecord(body));
  const canonical_bytes = canonicalDocument(asJson(record));
  return Object.freeze({ candidate: Object.freeze({ record, canonical_bytes, record_identity: await contentIdentity(canonical_bytes) }), gradeOutputPayload, outputRef });
}

async function outputReceiptCarrier(root: EvidenceSpineRootV1, rootIdentity: ContentIdentity, candidate: DetachedRecordCandidate, target: Awaited<ReturnType<typeof makeTarget>>, subject: ContentIdentity, outputRef: SourceReceiptRefV1, outputPayload: Obj) {
  const carrier = {
    schemaVersion: 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1', rootIdentity, candidateIdentity: candidate.record_identity,
    resolutions: candidate.record.source_receipts.map((ref) => {
      const payload = ref.receipt_kind === 'GRADE_OUTPUT' ? outputPayload : target.payloads.find((item) => item.receiptKind === ref.receipt_kind);
      if (!payload) throw new Error('FIXTURE_OUTPUT_RECEIPT_MISSING');
      return resolution(ref, payload, subject, ref.receipt_kind === 'GRADE_OUTPUT' ? '7' : ref.receipt_kind === 'BUILD' ? 'a' : ref.receipt_kind === 'CONTROL_PLANE' ? 'c' : 'e');
    }),
  };
  const settled = await doc(carrier);
  const verified = await verifyIntegrationReceiptResolutionCarrier(root, candidate, settled.bytes, settled.identity);
  if (!verified || !candidate.record.source_receipts.some((ref) => ref.receipt_kind === 'GRADE_OUTPUT' && JSON.stringify(ref) === JSON.stringify(outputRef))) throw new Error('FIXTURE_OUTPUT_RECEIPT_REVERIFY_FAILED');
  return Object.freeze({ carrier, ...settled, verified });
}

function fixtureRoot(
  implementationPlanIdentity: ContentIdentity,
  matrixIdentity: ContentIdentity,
  answerKeyIdentity: ContentIdentity,
): EvidenceSpineRootV1 {
  return {
    schema_version: 'MES-1',
    source_identities: {
      specification: implementationPlanIdentity,
      implementation_plan: implementationPlanIdentity,
      matrix: matrixIdentity,
      answer_key: answerKeyIdentity,
      historical_task4_capsule: implementationPlanIdentity,
      failure_tell_definitions: implementationPlanIdentity,
      negative_control_definitions: implementationPlanIdentity,
      successor_lane_definition: implementationPlanIdentity,
      first_vertical_journey: implementationPlanIdentity,
      record_schemas: implementationPlanIdentity,
      deterministic_reducer: implementationPlanIdentity,
      task13_experiment: implementationPlanIdentity,
      closure_rule: implementationPlanIdentity,
      n9_successor_policy: implementationPlanIdentity,
    },
    slice_ids: ['N0'],
    requirements: [{ id: 'N0-D1', slice_id: 'N0', gate: 'D', independence: 'NON_BUILDER' }],
    failure_tell_definitions: [],
    failure_tell_links: [],
    negative_controls: [],
    conditional_claims: [],
    successor_lane: {
      schema_version: 'MES-1', lane_id: 'N9_SUCCESSOR_V1',
      blocked_requirement_ids: ['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1'],
      required_negative_control_ids: ['NC-ACCESS', 'NC-DELETE', 'NC-SCOPE', 'NC-SURVEILLANCE'],
      required_authorization_bindings: [], safeguard_dimensions: [], stop_condition_ids: [],
      maximum_claim: 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY_FIXTURE',
    },
    first_vertical_journey: {
      schema_version: 'MES-1', journey_id: 'fixture-first-vertical', learner_locale: 'ko',
      distinct_account_roles: ['LEARNER_A', 'LEARNER_B'],
      required_target_identity_kinds: ['AI_INVOCATION_ATTEMPT', 'TRAINING_SCENARIO_EVIDENCE', 'TRAINING_SCENARIO_PACK'],
      ordered_step_ids: [
        'bind-runtime-identities', 'authenticate-distinct-accounts', 'select-books-and-query-in-korean',
        'complete-two-attributable-training-turns', 'inspect-evidence-and-provenance',
        'create-growth-consent-and-private-space', 'open-growth-cycle-from-training-origin',
        'contest-gap-and-choose-practice', 'schedule-real-recheck', 'attempt-foreign-account-operations',
        'exercise-korean-accessibility', 'delete-cycle-and-inspect-residue', 'emit-detached-evidence-candidates',
      ],
      immediate_evidence_scopes: ['account-isolation', 'context-binding', 'korean-comprehension'],
      longitudinal_follow_up: 'SEPARATELY_GATED_AFTER_CONTEXT_CHANGE',
    },
    record_schemas: {
      schema_version: 'MES-1', common_envelope: 'fixture-envelope', families: ['ARTIFACT', 'NEGATIVE_CONTROL_RESULT', 'GRADE', 'CORRECTION'],
      artifact_kind_details: ['GRADE_INPUT'], vocabulary: { artifact_statuses: ['PENDING', 'PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE'], grade_verdicts: ['SAME GRADE', 'A CLEARLY BETTER', 'B CLEARLY BETTER', 'UNGRADABLE'] },
    },
    deterministic_reducer: {
      schema_version: 'MES-1', reducer_id: 'fixture-reducer', admitted_record_rule: 'ADMITTED_ACTIVE_RECORDS_ONLY',
      active_record_rule: 'ALL_UNSUPERSEDED_RECORDS_PER_EVIDENCE_KEY',
      status_precedence: ['BLOCKED_CONTRACT', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'PENDING', 'PASS'],
      pass_prerequisites: [], correction_rule: 'EXACT_TARGET_AND_ADMITTED_SAME_ROOT_REPLACEMENTS',
      missing_evidence_rule: 'PENDING_OR_UNKNOWN_NEVER_PASS',
    },
    task13_experiment: {
      schema_version: 'MES-1', experiment_id: 'fixture-task13', separately_authorized: true,
      pre_e2e_prerequisite: false, pre_authorization_output: 'CONFIGURATION_ONLY',
      prohibited_claims: ['EXPERIMENT_PASSED', 'FIFTY_PERCENT_REDUCTION_PROVED'],
      later_execution_contract: 'EXACT_ROOT_AND_SEPARATE_DIRECT_AUTHORIZATION_REQUIRED',
    },
    closure_rule: {
      schema_version: 'MES-1', unauthorized_status: 'NOT_EVALUATED', incomplete_status: 'NOT_CLEARED',
      cleared_status: 'CLEARED', required_conditions: [],
    },
    n9_successor_policy: {
      schemaVersion: 'MES-1', policyId: 'N9_SUCCESSOR_POLICY_V1', implementationPlanIdentity,
      historicalCapsuleIdentity: implementationPlanIdentity, successorLaneId: 'N9_SUCCESSOR_V1',
      blockedRequirementIds: ['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1'], accountAliasIdentities: [],
      allowedActionIds: [], allowedFileIds: [], prohibitedActionIds: [], stopConditionIds: [],
      maximumClaim: 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY_FIXTURE', controls: [],
      declaredStorePolicyIdentity: implementationPlanIdentity, privateContainerPolicyIdentities: [],
    },
  };
}

type FixtureOptions = Readonly<{
  includeFourthResolvedReceipt?: boolean;
  oneContentMarkdown?: string;
  twoContentMarkdown?: string;
  semanticBrandingTokens?: readonly string[];
  visualBrandingTokens?: readonly string[];
  oneDisclosureTokens?: readonly string[];
  twoDisclosureTokens?: readonly string[];
  rootMatrixIdentity?: ContentIdentity;
  rootAnswerKeyIdentity?: ContentIdentity;
}>;

async function fixture(options: boolean | FixtureOptions = false) {
  const config: FixtureOptions = typeof options === 'boolean'
    ? { includeFourthResolvedReceipt: options }
    : options;
  const rawMatrix = encoder.encode('{\n  "fixture_matrix": ["local"]\n}\n');
  const rawAnswer = encoder.encode('# Fixture answer key\n');
  const matrixIdentity = await contentIdentity(rawMatrix);
  const answerKeyIdentity = await contentIdentity(rawAnswer);
  const planIdentity = (await doc({ fixture: 'implementation-plan' })).identity;
  const root = fixtureRoot(planIdentity, config.rootMatrixIdentity ?? matrixIdentity, config.rootAnswerKeyIdentity ?? answerKeyIdentity);
  const rootIdentity = (await doc(root)).identity;
  const subject = (await doc({ fixture: 'subject' })).identity;
  const account = (await doc({ fixture: 'account' })).identity;
  const target = await makeTarget(subject, account, config.includeFourthResolvedReceipt === true);
  const targetLink = { rootIdentity, implementationPlanIdentity: planIdentity, buildIdentity: target.buildIdentity, deploymentIdentity: target.deploymentIdentity, routeManifestIdentity: target.routeManifestIdentity, controlPlaneIdentity: target.controlPlaneIdentity, supportingReceiptRefs: target.targetRefs };
  const targetLinkIdentity = (await doc(targetLink)).identity;
  const preimage = { schemaVersion: 'MES-GRADE-STATE-PREIMAGE-1', rootIdentity, targetLink, evidenceCategoryIds: ['N0-D1'] };
  const preimageIdentity = (await doc(preimage)).identity;
  const viewport = { schemaVersion: 'MES-GRADE-VIEWPORT-PROFILE-1', rootIdentity, targetLinkIdentity, widthCssPixels: 1280, heightCssPixels: 720, deviceScaleFactor: 1 };
  const context = { schemaVersion: 'MES-GRADE-CONTEXT-PROFILE-1', rootIdentity, targetLinkIdentity, locale: 'en-US', timeZone: 'UTC' };
  const viewportIdentity = (await doc(viewport)).identity;
  const contextIdentity = (await doc(context)).identity;
  const descriptor = { schemaVersion: 'MES-GRADE-STATE-DESCRIPTOR-1', rootIdentity, statePreimageIdentity: preimageIdentity, viewportProfileIdentity: viewportIdentity, contextProfileIdentity: contextIdentity, targetLinkIdentity };
  const descriptorIdentity = (await doc(descriptor)).identity;
  const redactedOne = await doc({ schemaVersion: 'MES-REDACTED-GRADE-MATERIAL-1', rootIdentity, targetLinkIdentity, stateDescriptorIdentity: descriptorIdentity, evidenceCategoryIds: ['N0-D1'], contentMarkdown: config.oneContentMarkdown ?? 'Local evidence presentation one.\n' });
  const redactedTwo = await doc({ schemaVersion: 'MES-REDACTED-GRADE-MATERIAL-1', rootIdentity, targetLinkIdentity, stateDescriptorIdentity: descriptorIdentity, evidenceCategoryIds: ['N0-D1'], contentMarkdown: config.twoContentMarkdown ?? 'Local evidence presentation two.\n' });
  const one = await artifact({ label: 'one', rootIdentity, subject, target, redactedIdentity: redactedOne.identity, builder: 'builder-one', vendor: 'BUILDER_VENDOR_ONE' });
  const two = await artifact({ label: 'two', rootIdentity, subject, target, redactedIdentity: redactedTwo.identity, builder: 'builder-two', vendor: 'BUILDER_VENDOR_TWO' });
  const prefix = await prefixFor(rootIdentity, [one.candidate, two.candidate]);
  const targetOne = await targetCarrier(root, rootIdentity, one.candidate, target, subject);
  const targetTwo = await targetCarrier(root, rootIdentity, two.candidate, target, subject);
  const policy = {
    schemaVersion: 'MES-BLIND-GRADE-SANITIZATION-POLICY-1', rootIdentity, policyId: 'STRIP_BRANDING_EXCLUDE_BUILDER_NARRATIVE_V1',
    forbiddenSemanticFields: ['builder_identity', 'builder_vendor_family', 'builder_report', 'reviewer_identity', 'reviewer_vendor_family', 'account_identity', 'raw_learner_content', 'plaintext_hash'], unavoidableDisclosureRule: 'SORTED_EXACT_DISCLOSURES_OR_REJECT',
  };
  const policyDoc = await doc(policy);
  const identities = [one.candidate.record_identity, two.candidate.record_identity].sort((left, right) => left.sha256.localeCompare(right.sha256) || left.byte_length - right.byte_length);
  const materialSet = { schemaVersion: 'MES-GRADE-MATERIAL-SET-1', rootIdentity, targetLinkIdentity, stateDescriptorIdentity: descriptorIdentity, gradeInputArtifactIdentities: identities };
  const materialSetIdentity = (await doc(materialSet)).identity;
  const semanticBrandingTokens = [...(config.semanticBrandingTokens ?? [])];
  const visualBrandingTokens = [...(config.visualBrandingTokens ?? [])];
  const treatment = semanticBrandingTokens.length === 0 && visualBrandingTokens.length === 0 ? 'STRIPPED' as const : 'UNAVOIDABLE_DISCLOSED' as const;
  const disclosure = await doc({ schemaVersion: 'MES-BRANDING-DISCLOSURE-RECEIPT-1', rootIdentity, gradeMaterialSetIdentity: materialSetIdentity, sanitizationPolicyIdentity: policyDoc.identity, semanticBrandingTokens, visualBrandingTokens, treatment });
  const assessment = { schemaVersion: 'MES-BRANDING-ASSESSMENT-1', rootIdentity, gradeMaterialSetIdentity: materialSetIdentity, sanitizationPolicyIdentity: policyDoc.identity, semanticBrandingTokens, visualBrandingTokens, treatment, externalAssessmentReceiptIdentity: disclosure.identity };
  const assessmentDoc = await doc(assessment);
  const branding = { schemaVersion: 'MES-BRANDING-ASSESSMENT-CARRIER-1', rootIdentity, assessmentBytesBase64: b64(assessmentDoc.bytes), assessmentIdentity: assessmentDoc.identity, disclosureReceiptBytesBase64: b64(disclosure.bytes), disclosureReceiptIdentity: disclosure.identity } as ExternalBrandingAssessmentCarrierV1;
  const mappingBody = { schemaVersion: 'MES-BLIND-MAPPING-COMMITMENT-BODY-1', rootIdentity, gradeMaterialSetIdentity: materialSetIdentity, candidateArtifactIdentity: one.candidate.record_identity, slotMapping: [{ slotId: 'SLOT_1', gradeInputArtifactIdentity: one.candidate.record_identity }, { slotId: 'SLOT_2', gradeInputArtifactIdentity: two.candidate.record_identity }], nonceCommitmentIdentity: fakeIdentity('9', 9), externalRandomizationReceiptIdentity: fakeIdentity('8', 8) };
  const mappingDoc = await doc(mappingBody);
  const mapping = { schemaVersion: 'MES-BLIND-MAPPING-COMMITMENT-1', rootIdentity, commitmentBytesBase64: b64(mappingDoc.bytes), commitmentIdentity: mappingDoc.identity } as ExternalBlindMappingCommitmentCarrierV1;
  const materialDocOne = await doc({ schemaVersion: 'MES-BLIND-GRADER-MATERIAL-1', slotId: 'SLOT_1', rootIdentity, gradeMaterialSetIdentity: materialSetIdentity, stateDescriptorIdentity: descriptorIdentity, redactedMaterialBytesBase64: b64(redactedOne.bytes), redactedMaterialIdentity: redactedOne.identity, unavoidableDisclosureTokens: [...(config.oneDisclosureTokens ?? [])] });
  const materialDocTwo = await doc({ schemaVersion: 'MES-BLIND-GRADER-MATERIAL-1', slotId: 'SLOT_2', rootIdentity, gradeMaterialSetIdentity: materialSetIdentity, stateDescriptorIdentity: descriptorIdentity, redactedMaterialBytesBase64: b64(redactedTwo.bytes), redactedMaterialIdentity: redactedTwo.identity, unavoidableDisclosureTokens: [...(config.twoDisclosureTokens ?? [])] });
  const materialOne = { schemaVersion: 'MES-VERIFIED-GRADE-INPUT-1', rootIdentity, prefixCarrierIdentity: prefix.identity, manifestHeadIdentity: prefix.headIdentity, gradeInputArtifactBytesBase64: b64(one.candidate.canonical_bytes), gradeInputArtifactIdentity: one.candidate.record_identity, targetReceiptCarrierBytesBase64: b64(targetOne.bytes), targetReceiptCarrierIdentity: targetOne.identity, statePreimageBytesBase64: b64((await doc(preimage)).bytes), statePreimageIdentity: preimageIdentity, stateDescriptorBytesBase64: b64((await doc(descriptor)).bytes), stateDescriptorIdentity: descriptorIdentity, graderMaterialBytesBase64: b64(materialDocOne.bytes), graderMaterialIdentity: materialDocOne.identity } as VerifiedActiveGradeInputCarrierV1;
  const materialTwo = { schemaVersion: 'MES-VERIFIED-GRADE-INPUT-1', rootIdentity, prefixCarrierIdentity: prefix.identity, manifestHeadIdentity: prefix.headIdentity, gradeInputArtifactBytesBase64: b64(two.candidate.canonical_bytes), gradeInputArtifactIdentity: two.candidate.record_identity, targetReceiptCarrierBytesBase64: b64(targetTwo.bytes), targetReceiptCarrierIdentity: targetTwo.identity, statePreimageBytesBase64: b64((await doc(preimage)).bytes), statePreimageIdentity: preimageIdentity, stateDescriptorBytesBase64: b64((await doc(descriptor)).bytes), stateDescriptorIdentity: descriptorIdentity, graderMaterialBytesBase64: b64(materialDocTwo.bytes), graderMaterialIdentity: materialDocTwo.identity } as VerifiedActiveGradeInputCarrierV1;
  const rubricBody = { schemaVersion: 'MES-GRADE-RUBRIC-1', rootIdentity, matrixIdentity, answerKeyIdentity, viewportProfileIdentity: viewportIdentity, contextProfileIdentity: contextIdentity, allowedVerdicts: ['SAME GRADE', 'A CLEARLY BETTER', 'B CLEARLY BETTER', 'UNGRADABLE'], allowedReasonCodes: ['EVIDENCE_PARITY', 'INTERACTION_PARITY', 'ACCESSIBILITY_PARITY', 'PRIVACY_PARITY', 'DELETION_PARITY', 'PROVENANCE_PARITY', 'ISOLATION_PARITY', 'KOREAN_COMPREHENSION_PARITY', 'TRUTHFUL_DEGRADATION_PARITY', 'DIMENSION_UNASSESSABLE'], instructionsMarkdown: 'Assess only sealed fixture material.\n' };
  const rubricDoc = await doc(rubricBody);
  const rubric = { schemaVersion: 'MES-GRADE-RUBRIC-CARRIER-1', rootIdentity, matrixBytesBase64: b64(rawMatrix), matrixIdentity, answerKeyBytesBase64: b64(rawAnswer), answerKeyIdentity, rubricBytesBase64: b64(rubricDoc.bytes), rubricIdentity: rubricDoc.identity, viewportProfileBytesBase64: b64((await doc(viewport)).bytes), viewportProfileIdentity: viewportIdentity, contextProfileBytesBase64: b64((await doc(context)).bytes), contextProfileIdentity: contextIdentity } as VerifiedGradeRubricCarrierV1;
  const packet = { schemaVersion: 'MES-BLIND-GRADE-PACKET-1', rootIdentity, targetLinkIdentity, stateDescriptorIdentity: descriptorIdentity, gradeMaterialSetIdentity: materialSetIdentity, matrixIdentity, answerKeyIdentity, rubricIdentity: rubricDoc.identity, rubricCarrier: rubric, sanitizationPolicyIdentity: policyDoc.identity, brandingAssessmentIdentity: assessmentDoc.identity, mappingCommitmentIdentity: mappingDoc.identity, items: [parseAuthorityJson(materialDocOne.bytes), parseAuthorityJson(materialDocTwo.bytes)] };
  const packetDoc = await doc(packet);
  const modelIdentity = fakeIdentity('6', 6);
  const gradeReceiptPayload = {
    receiptKind: 'GRADE_OUTPUT', subjectIdentity: subject, accountScopeIdentity: account,
    causal: {
      packetIdentity: packetDoc.identity,
      graderIdentity: (await doc({ reviewerIdentity: 'independent-fixture-grader', modelIdentity })).identity,
      graderFamily: 'INDEPENDENT_GRADER_VENDOR', verdict: 'SAME GRADE', reasonCodes: ['EVIDENCE_PARITY'],
    },
  };
  const grader = { reviewerIdentity: 'independent-fixture-grader', vendorFamily: 'INDEPENDENT_GRADER_VENDOR', modelIdentity, independenceReceiptIdentity: (await doc(gradeReceiptPayload)).identity };
  const output = { schemaVersion: 'MES-BLIND-GRADE-OUTPUT-1', rootIdentity, packetIdentity: packetDoc.identity, grader, verdict: 'SAME GRADE', reasonCodes: ['EVIDENCE_PARITY'], unassessableDimensions: [] };
  const outputDoc = await doc(output);
  const outputBootstrap = await deriveOutputBootstrapCandidate({ rootIdentity, subject, target, packetIdentity: packetDoc.identity, rubricIdentity: rubricDoc.identity, matrixIdentity, mappingIdentity: mappingDoc.identity, outputIdentity: outputDoc.identity, output });
  const outputReceipt = await outputReceiptCarrier(root, rootIdentity, outputBootstrap.candidate, target, subject, outputBootstrap.outputRef, outputBootstrap.gradeOutputPayload);
  const brandingDoc = await doc(branding);
  const outputCarrier = { schemaVersion: 'MES-GRADE-OUTPUT-CARRIER-1', rootIdentity, packetBytesBase64: b64(packetDoc.bytes), packetIdentity: packetDoc.identity, outputBytesBase64: b64(outputDoc.bytes), outputIdentity: outputDoc.identity, outputReceiptCarrierBytesBase64: b64(outputReceipt.bytes), outputReceiptCarrierIdentity: outputReceipt.identity, mappingCommitmentBytesBase64: b64(mappingDoc.bytes), mappingCommitmentIdentity: mappingDoc.identity, brandingAssessmentCarrierBytesBase64: b64(brandingDoc.bytes), brandingAssessmentCarrierIdentity: brandingDoc.identity, candidateArtifactIdentity: one.candidate.record_identity, grader, producedAt: '2026-09-05T00:00:00.000Z' };
  const outputCarrierDoc = await doc(outputCarrier);
  return Object.freeze({ root, rootIdentity, rawMatrix, rawAnswer, target, targetLink, preimage, descriptor, one, two, prefix, targetOne, targetTwo, policy, policyDoc, materialSet, materialSetIdentity, disclosure, assessment, assessmentDoc, branding, brandingDoc, mappingBody, mappingDoc, mapping, materialDocOne, materialDocTwo, materialOne, materialTwo, rubricBody, rubricDoc, rubric, packet, packetDoc, grader, output, outputDoc, outputBootstrap, outputReceipt, outputCarrier, outputCarrierDoc });
}

const fixturePromise = fixture();

type AdapterModule = typeof BlindGradeAdapterModule;
type BuildFn = AdapterModule['buildBlindGradePacket'];
type CandidateFn = AdapterModule['prepareBlindGradeCandidate'];
type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<Type extends true> = Type;
type ExpectedBuildParameters = [
  root: EvidenceSpineRootV1,
  prefix: VerifiedManifestPrefixCarrierV1,
  rubric: VerifiedGradeRubricCarrierV1,
  policyBytes: Uint8Array,
  policyIdentity: ContentIdentity,
  materialOne: VerifiedActiveGradeInputCarrierV1,
  materialTwo: VerifiedActiveGradeInputCarrierV1,
  mapping: ExternalBlindMappingCommitmentCarrierV1,
  branding: ExternalBrandingAssessmentCarrierV1,
];
type ExpectedCandidateParameters = [
  root: EvidenceSpineRootV1,
  packet: FrozenBlindGradePacketV1,
  output: VerifiedGradeOutputCarrierV1,
  prefix: VerifiedManifestPrefixCarrierV1,
  materialOne: VerifiedActiveGradeInputCarrierV1,
  materialTwo: VerifiedActiveGradeInputCarrierV1,
];
type ExpectedBuildResult = FrozenBlindGradePacketV1 | NonPassingObservation;
type ExpectedCandidateResult = PreparedBlindGradeCandidateV1 | NonPassingObservation;
type _ModuleKeys = Assert<Equal<keyof AdapterModule, 'buildBlindGradePacket' | 'prepareBlindGradeCandidate'>>;
type _BuildParameters = Assert<Equal<Parameters<BuildFn>, ExpectedBuildParameters>>;
type _CandidateParameters = Assert<Equal<Parameters<CandidateFn>, ExpectedCandidateParameters>>;
type _BuildPromise = Assert<Equal<ReturnType<BuildFn>, Promise<ExpectedBuildResult>>>;
type _CandidatePromise = Assert<Equal<ReturnType<CandidateFn>, Promise<ExpectedCandidateResult>>>;
type _BuildAwaited = Assert<Equal<Awaited<ReturnType<BuildFn>>, ExpectedBuildResult>>;
type _CandidateAwaited = Assert<Equal<Awaited<ReturnType<CandidateFn>>, ExpectedCandidateResult>>;
type MutableClone<Value> =
  Value extends Uint8Array ? Uint8Array :
  Value extends readonly [unknown, ...unknown[]] ? { -readonly [Key in keyof Value]: MutableClone<Value[Key]> } :
  Value extends readonly (infer Item)[] ? MutableClone<Item>[] :
  Value extends object ? { -readonly [Key in keyof Value]: MutableClone<Value[Key]> } :
  Value;
type TestBuildInput = {
  root: MutableClone<ExpectedBuildParameters[0]>;
  prefix: MutableClone<ExpectedBuildParameters[1]>;
  rubric: MutableClone<ExpectedBuildParameters[2]>;
  policyBytes: MutableClone<ExpectedBuildParameters[3]>;
  policyIdentity: MutableClone<ExpectedBuildParameters[4]>;
  materialOne: MutableClone<ExpectedBuildParameters[5]>;
  materialTwo: MutableClone<ExpectedBuildParameters[6]>;
  mapping: MutableClone<ExpectedBuildParameters[7]>;
  branding: MutableClone<ExpectedBuildParameters[8]>;
};
type TestCandidateInput = {
  root: MutableClone<ExpectedCandidateParameters[0]>;
  packet: MutableClone<ExpectedCandidateParameters[1]>;
  output: MutableClone<ExpectedCandidateParameters[2]>;
  prefix: MutableClone<ExpectedCandidateParameters[3]>;
  materialOne: MutableClone<ExpectedCandidateParameters[4]>;
  materialTwo: MutableClone<ExpectedCandidateParameters[5]>;
};

async function adapterApi(): Promise<AdapterModule> {
  return import(adapterPath);
}

function expectNonPassing(value: unknown, reason: string): void {
  const observation = value as Obj;
  expect(Object.keys(observation).sort()).toEqual(['failureTellIds', 'outcome', 'reason', 'receiptRefs']);
  expect(observation.outcome).toMatch(/^(?:FAIL|UNKNOWN|UNGRADABLE)$/u);
  expect(observation.reason).toBe(reason);
  expect(Array.isArray(observation.failureTellIds)).toBe(true);
  expect(Array.isArray(observation.receiptRefs)).toBe(true);
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function expectData(actual: unknown, expected: unknown): void {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    expect(equalBytes(actual, expected)).toBe(true);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    expect(actual).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index += 1) expectData(actual[index], expected[index]);
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const actualObject = actual as Obj;
    const expectedObject = expected as Obj;
    expectExactKeys(actualObject, Object.keys(expectedObject));
    for (const key of Object.keys(expectedObject)) expectData(actualObject[key], expectedObject[key]);
    return;
  }
  expect(actual).toBe(expected);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) assertDeepFrozen(nested, seen);
}

function assertDetached(bytes: Uint8Array, sources: readonly Uint8Array[]): void {
  for (const source of sources) {
    expect(bytes).not.toBe(source);
    expect(bytes.buffer).not.toBe(source.buffer);
  }
}

async function expectCanonicalPair(bytes: Uint8Array, identity: ContentIdentity): Promise<void> {
  expectExactKeys(identity, ['byte_length', 'sha256']);
  const recomputed = await contentIdentity(bytes);
  expect(identity.byte_length).toBe(recomputed.byte_length);
  expect(identity.sha256).toBe(recomputed.sha256);
}

function decodedBase64(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  expect(b64(bytes)).toBe(value);
  return bytes;
}

async function materialCandidateFromRaw(material: MutableClone<VerifiedActiveGradeInputCarrierV1>) {
  const bytes = decodedBase64(material.gradeInputArtifactBytesBase64);
  await expectCanonicalPair(bytes, material.gradeInputArtifactIdentity);
  const record = requireGradeInputRecord(validateEvidenceRecord(parseAuthorityJson(bytes)));
  return Object.freeze({ record, canonical_bytes: bytes, record_identity: await contentIdentity(bytes) });
}

async function targetFromRaw(
  root: MutableClone<EvidenceSpineRootV1>,
  rootIdentity: ContentIdentity,
  material: MutableClone<VerifiedActiveGradeInputCarrierV1>,
  candidate: DetachedRecordCandidate,
) {
  const bytes = decodedBase64(material.targetReceiptCarrierBytesBase64);
  await expectCanonicalPair(bytes, material.targetReceiptCarrierIdentity);
  const verified = await verifyIntegrationReceiptResolutionCarrier(root, candidate, bytes, material.targetReceiptCarrierIdentity);
  if (!verified) throw new Error('EXPECTED_TARGET_REVERIFY_FAILED');
  const carrier = parseAuthorityJson(bytes) as Obj;
  const resolutions = carrier.resolutions as Obj[];
  const payloadFor = (kind: string): Obj => {
    const resolution = resolutions.find((value) => (value.ref as Obj).receipt_kind === kind);
    if (!resolution) throw new Error(`EXPECTED_TARGET_${kind}_MISSING`);
    return resolution.payload as Obj;
  };
  const build = payloadFor('BUILD');
  const deployment = payloadFor('DEPLOYMENT');
  const control = payloadFor('CONTROL_PLANE');
  const refs: SourceReceiptRefV1[] = resolutions.map((resolution) => {
    const ref = jsonObject(resolution.ref);
    const kind = ref.receipt_kind;
    if (kind !== 'BUILD' && kind !== 'CONTROL_PLANE' && kind !== 'DEPLOYMENT') throw new Error('EXPECTED_TARGET_RECEIPT_KIND');
    if (typeof ref.receipt_id !== 'string') throw new Error('EXPECTED_TARGET_RECEIPT_ID');
    return { receipt_kind: kind, receipt_id: ref.receipt_id, content_identity: identityFromJson(ref.content_identity) };
  });
  const targetLink = {
    rootIdentity,
    implementationPlanIdentity: (root.source_identities as Obj).implementation_plan as ContentIdentity,
    buildIdentity: (build.causal as Obj).buildIdentity as ContentIdentity,
    deploymentIdentity: (deployment.causal as Obj).deploymentIdentity as ContentIdentity,
    routeManifestIdentity: (control.causal as Obj).routeManifestIdentity as ContentIdentity,
    controlPlaneIdentity: (control.causal as Obj).controlPlaneIdentity as ContentIdentity,
    supportingReceiptRefs: refs,
  };
  return Object.freeze({
    targetLink,
    targetLinkIdentity: await contentIdentity(canonicalDocument(asJson(targetLink))),
    subject: build.subjectIdentity as ContentIdentity,
    account: build.accountScopeIdentity as ContentIdentity,
    refs,
  });
}

async function deriveExpectedPacketFromRawAuthorities(input: TestBuildInput): Promise<FrozenBlindGradePacketV1> {
  const source = structuredClone(input);
  const rootIdentity = await contentIdentity(canonicalDocument(asJson(source.root)));
  const prefix = await verifyManifestPrefixCarrier(rootIdentity, source.materialOne.manifestHeadIdentity, source.prefix.carrierBytes, source.prefix.carrierIdentity);
  if (!prefix) throw new Error('EXPECTED_PREFIX_REVERIFY_FAILED');
  const one = await materialCandidateFromRaw(source.materialOne);
  const two = await materialCandidateFromRaw(source.materialTwo);
  const targetOne = await targetFromRaw(source.root, rootIdentity, source.materialOne, one);
  const targetTwo = await targetFromRaw(source.root, rootIdentity, source.materialTwo, two);
  expectData(targetOne.targetLink, targetTwo.targetLink);
  const materialIdentities = [one.record_identity, two.record_identity].sort((left, right) => left.sha256.localeCompare(right.sha256) || left.byte_length - right.byte_length);
  const descriptorBytes = decodedBase64(source.materialOne.stateDescriptorBytesBase64);
  await expectCanonicalPair(descriptorBytes, source.materialOne.stateDescriptorIdentity);
  const materialSet = {
    schemaVersion: 'MES-GRADE-MATERIAL-SET-1',
    rootIdentity,
    targetLinkIdentity: targetOne.targetLinkIdentity,
    stateDescriptorIdentity: source.materialOne.stateDescriptorIdentity,
    gradeInputArtifactIdentities: materialIdentities,
  };
  const materialSetIdentity = await contentIdentity(canonicalDocument(asJson(materialSet)));
  const policyIdentity = await contentIdentity(source.policyBytes);
  expectData(policyIdentity, source.policyIdentity);
  const rubricPairs = [
    ['matrixBytesBase64', 'matrixIdentity'],
    ['answerKeyBytesBase64', 'answerKeyIdentity'],
    ['rubricBytesBase64', 'rubricIdentity'],
    ['viewportProfileBytesBase64', 'viewportProfileIdentity'],
    ['contextProfileBytesBase64', 'contextProfileIdentity'],
  ] as const;
  for (const [bytesKey, identityKey] of rubricPairs) {
    await expectCanonicalPair(decodedBase64(source.rubric[bytesKey]), source.rubric[identityKey]);
  }
  const mappingBytes = decodedBase64(source.mapping.commitmentBytesBase64);
  await expectCanonicalPair(mappingBytes, source.mapping.commitmentIdentity);
  const brandingBytes = decodedBase64(source.branding.assessmentBytesBase64);
  await expectCanonicalPair(brandingBytes, source.branding.assessmentIdentity);
  const itemOne = gradeMaterialFromJson(parseAuthorityJson(decodedBase64(source.materialOne.graderMaterialBytesBase64)));
  const itemTwo = gradeMaterialFromJson(parseAuthorityJson(decodedBase64(source.materialTwo.graderMaterialBytesBase64)));
  const packet: BlindGradePacketBodyV1 = {
    schemaVersion: 'MES-BLIND-GRADE-PACKET-1',
    rootIdentity,
    targetLinkIdentity: targetOne.targetLinkIdentity,
    stateDescriptorIdentity: source.materialOne.stateDescriptorIdentity,
    gradeMaterialSetIdentity: materialSetIdentity,
    matrixIdentity: source.rubric.matrixIdentity,
    answerKeyIdentity: source.rubric.answerKeyIdentity,
    rubricIdentity: source.rubric.rubricIdentity,
    rubricCarrier: structuredClone(source.rubric),
    sanitizationPolicyIdentity: source.policyIdentity,
    brandingAssessmentIdentity: source.branding.assessmentIdentity,
    mappingCommitmentIdentity: source.mapping.commitmentIdentity,
    items: [itemOne, itemTwo],
  };
  const packetBytes = canonicalDocument(asJson(packet));
  return Object.freeze({
    packet,
    packetBytes,
    packetIdentity: await contentIdentity(packetBytes),
  });
}

async function assertPositivePacket(
  value: FrozenBlindGradePacketV1 | NonPassingObservation,
  expected: FrozenBlindGradePacketV1,
  sources: readonly Uint8Array[],
): Promise<FrozenBlindGradePacketV1> {
  expectNonPassingOrPacket(value);
  const packet = value;
  expectExactKeys(packet, ['packet', 'packetBytes', 'packetIdentity']);
  expectExactKeys(packet.packet, [
    'schemaVersion', 'rootIdentity', 'targetLinkIdentity', 'stateDescriptorIdentity',
    'gradeMaterialSetIdentity', 'matrixIdentity', 'answerKeyIdentity', 'rubricIdentity',
    'rubricCarrier', 'sanitizationPolicyIdentity', 'brandingAssessmentIdentity',
    'mappingCommitmentIdentity', 'items',
  ]);
  expectData(packet.packet, expected.packet);
  expect(equalBytes(packet.packetBytes, expected.packetBytes)).toBe(true);
  await expectCanonicalPair(packet.packetBytes, packet.packetIdentity);
  expectData(parseAuthorityJson(packet.packetBytes), expected.packet);
  assertDeepFrozen(packet);
  assertDetached(packet.packetBytes, sources);
  const returnedCopy = new Uint8Array(packet.packetBytes);
  returnedCopy[0] ^= 1;
  expect(equalBytes(expected.packetBytes, packet.packetBytes)).toBe(true);
  return packet;
}

function expectNonPassingOrPacket(value: FrozenBlindGradePacketV1 | NonPassingObservation): asserts value is FrozenBlindGradePacketV1 {
  expect('reason' in value).toBe(false);
}

async function deriveExpectedCandidateFromRawAuthorities(
  input: TestCandidateInput,
  expectedPacket: FrozenBlindGradePacketV1,
): Promise<PreparedBlindGradeCandidateV1> {
  const source = structuredClone(input);
  const rootIdentity = await contentIdentity(canonicalDocument(asJson(source.root)));
  const prefix = await verifyManifestPrefixCarrier(rootIdentity, source.materialOne.manifestHeadIdentity, source.prefix.carrierBytes, source.prefix.carrierIdentity);
  if (!prefix) throw new Error('EXPECTED_PREFIX_REVERIFY_FAILED');
  const one = await materialCandidateFromRaw(source.materialOne);
  const two = await materialCandidateFromRaw(source.materialTwo);
  const target = await targetFromRaw(source.root, rootIdentity, source.materialOne, one);
  const targetTwo = await targetFromRaw(source.root, rootIdentity, source.materialTwo, two);
  expectData(target.targetLink, targetTwo.targetLink);
  expect(prefix.prefix.entries.some((entry) => entry.candidate_identity !== null
    && entry.candidate_identity.sha256 === one.record_identity.sha256
    && entry.candidate_identity.byte_length === one.record_identity.byte_length)).toBe(true);
  expect(prefix.prefix.entries.some((entry) => entry.candidate_identity !== null
    && entry.candidate_identity.sha256 === two.record_identity.sha256
    && entry.candidate_identity.byte_length === two.record_identity.byte_length)).toBe(true);
  const packetIdentity = await contentIdentity(source.packet.packetBytes);
  expectData(packetIdentity, source.packet.packetIdentity);
  expect(equalBytes(source.packet.packetBytes, expectedPacket.packetBytes)).toBe(true);
  const outer = parseAuthorityJson(source.output.carrierBytes) as Obj;
  expectExactKeys(outer, [
    'brandingAssessmentCarrierBytesBase64', 'brandingAssessmentCarrierIdentity', 'candidateArtifactIdentity',
    'grader', 'mappingCommitmentBytesBase64', 'mappingCommitmentIdentity', 'outputBytesBase64',
    'outputIdentity', 'outputReceiptCarrierBytesBase64', 'outputReceiptCarrierIdentity', 'packetBytesBase64',
    'packetIdentity', 'producedAt', 'rootIdentity', 'schemaVersion',
  ]);
  const outputBytes = decodedBase64(outer.outputBytesBase64 as string);
  const outputIdentity = outer.outputIdentity as ContentIdentity;
  await expectCanonicalPair(outputBytes, outputIdentity);
  const output = parseAuthorityJson(outputBytes) as Obj;
  const grader = output.grader as Obj;
  const mappingBytes = decodedBase64(outer.mappingCommitmentBytesBase64 as string);
  const mappingIdentity = outer.mappingCommitmentIdentity as ContentIdentity;
  await expectCanonicalPair(mappingBytes, mappingIdentity);
  const mapping = parseAuthorityJson(mappingBytes) as Obj;
  const candidateIdentity = mapping.candidateArtifactIdentity as ContentIdentity;
  const candidateRecord = [one, two].find((value) =>
    value.record_identity.sha256 === candidateIdentity.sha256 &&
    value.record_identity.byte_length === candidateIdentity.byte_length,
  );
  if (!candidateRecord) throw new Error('EXPECTED_MAPPING_CANDIDATE_MISSING');
  const deriveCandidate = async () => {
    const gradeOutputPayload = {
      receiptKind: 'GRADE_OUTPUT',
      subjectIdentity: target.subject,
      accountScopeIdentity: target.account,
      causal: {
        packetIdentity,
        graderIdentity: (await doc({ reviewerIdentity: grader.reviewerIdentity, modelIdentity: grader.modelIdentity })).identity,
        graderFamily: grader.vendorFamily,
        verdict: output.verdict,
        reasonCodes: output.reasonCodes,
      },
    };
    const outputRef = {
      receipt_kind: 'GRADE_OUTPUT' as const,
      receipt_id: 'receipt-grade-output',
      content_identity: (await doc(gradeOutputPayload)).identity,
    };
    const sourceRefMap = new Map<string, SourceReceiptRefV1>();
    for (const ref of [...one.record.source_receipts, ...two.record.source_receipts, outputRef]) {
      sourceRefMap.set(`${ref.receipt_kind}\0${ref.receipt_id}`, ref);
    }
    const gradeRunId = `GRADE:${packetIdentity.sha256}:${outputIdentity.sha256}`;
    const evidenceKey = await recordSha256(asJson({
      schema_version: 'MES-EVIDENCE-KEY-1', record_family: 'GRADE', root_identity: rootIdentity, grade_run_id: gradeRunId,
    }));
    const candidatePayload = {
      id: gradeRunId, slice_ids: stringsSorted([one.record.payload.slice_id, two.record.payload.slice_id]),
      frozen_rubric_sha256: expectedPacket.packet.rubricIdentity.sha256, matrix_sha256: expectedPacket.packet.matrixIdentity.sha256,
      artifact_ids: stringsSorted([one.record.payload.id, two.record.payload.id]),
      builder_vendor_family: candidateRecord.record.producer_identity.vendor_family, grader_vendor_family: grader.vendorFamily,
      grader_is_non_builder: candidateRecord.record.producer_identity.vendor_family !== grader.vendorFamily,
      builder_report_used: false, branding_treatment: 'STRIPPED', same_state_material: true,
      mapping_commitment: mappingIdentity.sha256, prompt_sha256: packetIdentity.sha256, verdict: output.verdict,
      reasons: output.reasonCodes, unassessable_dimensions: output.unassessableDimensions,
      timestamp: outer.producedAt, output_sha256: outputIdentity.sha256,
    };
    const recordBody: Obj = {
      schema_version: 'MES-1', record_family: 'GRADE', record_id: '0'.repeat(64), root_identity: rootIdentity,
      evidence_key: evidenceKey, subject_identity: one.record.subject_identity, created_at: outer.producedAt,
      producer_identity: {
        producer_id: (grader.modelIdentity as ContentIdentity).sha256, role: 'INDEPENDENT_GRADER',
        vendor_family: grader.vendorFamily, attestation: (grader.independenceReceiptIdentity as ContentIdentity).sha256,
      },
      source_receipts: refsSorted([...sourceRefMap.values()]), limitations: one.record.limitations,
      independent_review: await pending((grader.modelIdentity as ContentIdentity).sha256), payload: candidatePayload,
    };
    const { record_id: _discarded, ...withoutId } = recordBody;
    recordBody.record_id = await recordSha256(asJson(withoutId));
    const record = requireGradeRecord(validateEvidenceRecord(recordBody));
    const canonicalBytes = canonicalDocument(asJson(record));
    return Object.freeze({
      candidate: Object.freeze({ record, canonical_bytes: canonicalBytes, record_identity: await contentIdentity(canonicalBytes) }),
      outputRef,
    });
  };
  const provisional = await deriveCandidate();
  const outputReceiptBytes = decodedBase64(outer.outputReceiptCarrierBytesBase64 as string);
  const outputReceiptIdentity = outer.outputReceiptCarrierIdentity as ContentIdentity;
  await expectCanonicalPair(outputReceiptBytes, outputReceiptIdentity);
  const verified = await verifyIntegrationReceiptResolutionCarrier(source.root, provisional.candidate, outputReceiptBytes, outputReceiptIdentity);
  if (!verified) throw new Error('EXPECTED_OUTPUT_RECEIPT_REVERIFY_FAILED');
  const resolved = verified.filter((item): item is Extract<ReceiptResolution, { status: 'RESOLVED' }> => item.status === 'RESOLVED' && item.ref.receipt_kind === 'GRADE_OUTPUT');
  if (resolved.length !== 1) throw new Error('EXPECTED_ONE_OUTPUT_RESOLUTION');
  const receipt = resolved[0]!;
  expectData(receipt.ref, provisional.outputRef);
  const causal = jsonObject(jsonObject(receipt.payload).causal);
  expectData(causal.packetIdentity, packetIdentity);
  expectData(causal.graderIdentity, (await doc({ reviewerIdentity: grader.reviewerIdentity, modelIdentity: grader.modelIdentity })).identity);
  expect(causal.graderFamily).toBe(grader.vendorFamily);
  expect(causal.verdict).toBe(output.verdict);
  expectData(causal.reasonCodes, output.reasonCodes);
  const final = await deriveCandidate();
  expect(equalBytes(final.candidate.canonical_bytes, provisional.candidate.canonical_bytes)).toBe(true);
  expectData(final.candidate.record_identity, provisional.candidate.record_identity);
  expectData(final.outputRef, provisional.outputRef);
  return Object.freeze({
    status: 'PENDING_INDEPENDENT_REVIEW',
    candidate: final.candidate,
    outputBytes,
    outputIdentity,
    pendingIndependentReview: await pending((grader.modelIdentity as ContentIdentity).sha256),
  } satisfies PreparedBlindGradeCandidateV1);
}

async function assertPositiveCandidate(
  value: PreparedBlindGradeCandidateV1 | NonPassingObservation,
  expected: PreparedBlindGradeCandidateV1,
  sources: readonly Uint8Array[],
): Promise<PreparedBlindGradeCandidateV1> {
  expectNonPassingOrPrepared(value);
  const prepared = value;
  expectExactKeys(prepared, ['candidate', 'outputBytes', 'outputIdentity', 'pendingIndependentReview', 'status']);
  expect(prepared.status).toBe('PENDING_INDEPENDENT_REVIEW');
  expectExactKeys(prepared.candidate, ['canonical_bytes', 'record', 'record_identity']);
  const record = requireGradeRecord(prepared.candidate.record);
  expectExactKeys(record, [
    'created_at', 'evidence_key', 'independent_review', 'limitations', 'payload', 'producer_identity',
    'record_family', 'record_id', 'root_identity', 'schema_version', 'source_receipts', 'subject_identity',
  ]);
  expectExactKeys(record.payload, [
    'artifact_ids', 'branding_treatment', 'builder_report_used', 'builder_vendor_family',
    'frozen_rubric_sha256', 'grader_is_non_builder', 'grader_vendor_family', 'id', 'mapping_commitment',
    'matrix_sha256', 'output_sha256', 'prompt_sha256', 'reasons', 'same_state_material', 'slice_ids',
    'timestamp', 'unassessable_dimensions', 'verdict',
  ]);
  expectData(prepared, expected);
  await expectCanonicalPair(prepared.outputBytes, prepared.outputIdentity);
  await expectCanonicalPair(prepared.candidate.canonical_bytes, prepared.candidate.record_identity);
  expect(equalBytes(prepared.candidate.canonical_bytes, canonicalDocument(asJson(prepared.candidate.record)))).toBe(true);
  expect(record.payload.id).not.toBe(record.evidence_key);
  expect(record.payload.id).not.toBe(record.record_id);
  expect(record.evidence_key).not.toBe(record.record_id);
  expectExactKeys(prepared.pendingIndependentReview, [
    'builder_identity', 'review_output_identity', 'reviewer_identity', 'separation', 'vendor_family', 'verdict',
  ]);
  expectData(prepared.pendingIndependentReview, prepared.candidate.record.independent_review);
  assertDeepFrozen(prepared);
  assertDetached(prepared.outputBytes, sources);
  assertDetached(prepared.candidate.canonical_bytes, sources);
  return prepared;
}

function expectNonPassingOrPrepared(value: PreparedBlindGradeCandidateV1 | NonPassingObservation): asserts value is PreparedBlindGradeCandidateV1 {
  expect('reason' in value).toBe(false);
}

function buildInput(value: Awaited<ReturnType<typeof fixture>>): TestBuildInput {
  return {
    root: structuredClone(value.root) as MutableClone<ExpectedBuildParameters[0]>,
    prefix: {
      carrierBytes: new Uint8Array(value.prefix.bytes),
      carrierIdentity: structuredClone(value.prefix.identity),
      prefix: structuredClone(value.prefix.verified.prefix),
    } as MutableClone<ExpectedBuildParameters[1]>,
    rubric: structuredClone(value.rubric) as MutableClone<ExpectedBuildParameters[2]>,
    policyBytes: new Uint8Array(value.policyDoc.bytes),
    policyIdentity: structuredClone(value.policyDoc.identity),
    materialOne: structuredClone(value.materialOne) as MutableClone<ExpectedBuildParameters[5]>,
    materialTwo: structuredClone(value.materialTwo) as MutableClone<ExpectedBuildParameters[6]>,
    mapping: structuredClone(value.mapping) as MutableClone<ExpectedBuildParameters[7]>,
    branding: structuredClone(value.branding) as MutableClone<ExpectedBuildParameters[8]>,
  };
}

function candidateInput(value: Awaited<ReturnType<typeof fixture>>, packet: FrozenBlindGradePacketV1): TestCandidateInput {
  return {
    root: structuredClone(value.root) as MutableClone<ExpectedCandidateParameters[0]>,
    packet: structuredClone(packet) as MutableClone<ExpectedCandidateParameters[1]>,
    output: {
      carrierBytes: new Uint8Array(value.outputCarrierDoc.bytes),
      carrierIdentity: structuredClone(value.outputCarrierDoc.identity),
    } as MutableClone<ExpectedCandidateParameters[2]>,
    prefix: {
      carrierBytes: new Uint8Array(value.prefix.bytes),
      carrierIdentity: structuredClone(value.prefix.identity),
      prefix: structuredClone(value.prefix.verified.prefix),
    } as MutableClone<ExpectedCandidateParameters[3]>,
    materialOne: structuredClone(value.materialOne) as MutableClone<ExpectedCandidateParameters[4]>,
    materialTwo: structuredClone(value.materialTwo) as MutableClone<ExpectedCandidateParameters[5]>,
  };
}

async function freshBuildCase(value: Awaited<ReturnType<typeof fixture>>): Promise<TestBuildInput> {
  return buildInput(value);
}

async function freshCandidateCase(value: Awaited<ReturnType<typeof fixture>>): Promise<TestCandidateInput> {
  const packet = await deriveExpectedPacketFromRawAuthorities(buildInput(value));
  return candidateInput(value, packet);
}

async function resealMapping(
  carrier: MutableClone<ExternalBlindMappingCommitmentCarrierV1>,
  change: (mapping: Obj) => void,
): Promise<void> {
  const mapping = structuredClone(parseAuthorityJson(decodedBase64(carrier.commitmentBytesBase64))) as Obj;
  change(mapping);
  const settled = await doc(mapping);
  carrier.commitmentBytesBase64 = b64(settled.bytes);
  carrier.commitmentIdentity = settled.identity;
}

async function resealOutputChain(value: Awaited<ReturnType<typeof fixture>>, change: (output: Obj, outer: Obj) => void) {
  const output = structuredClone(parseAuthorityJson(value.outputDoc.bytes)) as Obj;
  const outer = structuredClone(parseAuthorityJson(value.outputCarrierDoc.bytes)) as Obj;
  change(output, outer);
  const grader = jsonObject(output.grader);
  const receiptPayload = {
    receiptKind: 'GRADE_OUTPUT',
    subjectIdentity: value.one.candidate.record.subject_identity.content_identity,
    accountScopeIdentity: (await doc({ fixture: 'account' })).identity,
    causal: {
      packetIdentity: value.packetDoc.identity,
      graderIdentity: (await doc({ reviewerIdentity: grader.reviewerIdentity, modelIdentity: grader.modelIdentity })).identity,
      graderFamily: grader.vendorFamily,
      verdict: output.verdict,
      reasonCodes: output.reasonCodes,
    },
  };
  grader.independenceReceiptIdentity = (await doc(receiptPayload)).identity;
  output.grader = grader;
  outer.grader = structuredClone(grader);
  const outputDoc = await doc(output);
  const bootstrap = await deriveOutputBootstrapCandidate({
    rootIdentity: value.rootIdentity,
    subject: value.one.candidate.record.subject_identity.content_identity,
    target: value.target,
    packetIdentity: value.packetDoc.identity,
    rubricIdentity: value.rubricDoc.identity,
    matrixIdentity: value.rubric.matrixIdentity,
    mappingIdentity: value.mappingDoc.identity,
    outputIdentity: outputDoc.identity,
    output,
  });
  const receipt = await outputReceiptCarrier(
    value.root,
    value.rootIdentity,
    bootstrap.candidate,
    value.target,
    value.one.candidate.record.subject_identity.content_identity,
    bootstrap.outputRef,
    bootstrap.gradeOutputPayload,
  );
  outer.outputBytesBase64 = b64(outputDoc.bytes);
  outer.outputIdentity = outputDoc.identity;
  outer.outputReceiptCarrierBytesBase64 = b64(receipt.bytes);
  outer.outputReceiptCarrierIdentity = receipt.identity;
  const settled = await doc(outer);
  return { carrierBytes: settled.bytes, carrierIdentity: settled.identity };
}

async function freshCandidateCaseWithResealedMapping(
  value: Awaited<ReturnType<typeof fixture>>,
  change: (mapping: Obj) => void,
): Promise<TestCandidateInput> {
  const raw = buildInput(value);
  const expectedPacket = await deriveExpectedPacketFromRawAuthorities(raw);
  const mapping = structuredClone(parseAuthorityJson(value.mappingDoc.bytes)) as Obj;
  change(mapping);
  const mappingDoc = await doc(mapping);
  const packetBody: BlindGradePacketBodyV1 = {
    ...expectedPacket.packet,
    mappingCommitmentIdentity: mappingDoc.identity,
  };
  const packetDoc = await doc(packetBody);
  const output = {
    ...structuredClone(value.output),
    packetIdentity: packetDoc.identity,
  };
  const outputDoc = await doc(output);
  const outputBootstrap = await deriveOutputBootstrapCandidate({
    rootIdentity: value.rootIdentity,
    subject: value.one.candidate.record.subject_identity.content_identity,
    target: value.target,
    packetIdentity: packetDoc.identity,
    rubricIdentity: value.rubricDoc.identity,
    matrixIdentity: value.rubric.matrixIdentity,
    mappingIdentity: mappingDoc.identity,
    outputIdentity: outputDoc.identity,
    output,
  });
  const outputReceipt = await outputReceiptCarrier(
    value.root,
    value.rootIdentity,
    outputBootstrap.candidate,
    value.target,
    value.one.candidate.record.subject_identity.content_identity,
    outputBootstrap.outputRef,
    outputBootstrap.gradeOutputPayload,
  );
  const outer = {
    ...structuredClone(value.outputCarrier),
    packetBytesBase64: b64(packetDoc.bytes),
    packetIdentity: packetDoc.identity,
    outputBytesBase64: b64(outputDoc.bytes),
    outputIdentity: outputDoc.identity,
    outputReceiptCarrierBytesBase64: b64(outputReceipt.bytes),
    outputReceiptCarrierIdentity: outputReceipt.identity,
    mappingCommitmentBytesBase64: b64(mappingDoc.bytes),
    mappingCommitmentIdentity: mappingDoc.identity,
  };
  const outerDoc = await doc(outer);
  return {
    root: structuredClone(value.root) as MutableClone<ExpectedCandidateParameters[0]>,
    packet: {
      packet: structuredClone(packetBody) as MutableClone<FrozenBlindGradePacketV1['packet']>,
      packetBytes: new Uint8Array(packetDoc.bytes),
      packetIdentity: structuredClone(packetDoc.identity),
    },
    output: { carrierBytes: new Uint8Array(outerDoc.bytes), carrierIdentity: structuredClone(outerDoc.identity) },
    prefix: {
      carrierBytes: new Uint8Array(value.prefix.bytes),
      carrierIdentity: structuredClone(value.prefix.identity),
      prefix: structuredClone(value.prefix.verified.prefix),
    } as MutableClone<ExpectedCandidateParameters[3]>,
    materialOne: structuredClone(value.materialOne) as MutableClone<ExpectedCandidateParameters[4]>,
    materialTwo: structuredClone(value.materialTwo) as MutableClone<ExpectedCandidateParameters[5]>,
  };
}

describe('Task 5 augmented causal RED fixture controls', () => {
  test('replays two admitted same-root GRADE_INPUT records before any absent adapter seam', async () => {
    const value = await fixturePromise;
    expect(() => validateEvidenceRecord(value.one.candidate.record)).not.toThrow();
    expect(() => validateEvidenceRecord(value.two.candidate.record)).not.toThrow();
    expect(value.prefix.verified.prefix.status).toBe('VERIFIED');
    expect(value.prefix.verified.prefix.entries).toHaveLength(3);
    expect(value.materialOne.manifestHeadIdentity).toEqual(value.materialTwo.manifestHeadIdentity);
    expect(value.materialOne.gradeInputArtifactIdentity).not.toEqual(value.materialTwo.gradeInputArtifactIdentity);
  });

  test('uses the accepted Task 4 integration receipt carrier for both target authorities and the provisional GRADE_OUTPUT bootstrap', async () => {
    const value = await fixturePromise;
    const one = await verifyIntegrationReceiptResolutionCarrier(value.root, value.one.candidate, value.targetOne.bytes, value.targetOne.identity);
    const two = await verifyIntegrationReceiptResolutionCarrier(value.root, value.two.candidate, value.targetTwo.bytes, value.targetTwo.identity);
    const output = await verifyIntegrationReceiptResolutionCarrier(value.root, value.outputBootstrap.candidate, value.outputReceipt.bytes, value.outputReceipt.identity);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(output).not.toBeNull();
    expect(one!.map((item) => item.status)).toEqual(['RESOLVED', 'RESOLVED', 'RESOLVED']);
    expect(one!.map((item) => item.status === 'RESOLVED' && item.ref.receipt_kind)).toEqual(['BUILD', 'CONTROL_PLANE', 'DEPLOYMENT']);
    expect(output!.map((item) => item.status === 'RESOLVED' && item.ref.receipt_kind)).toEqual(['BUILD', 'CONTROL_PLANE', 'DEPLOYMENT', 'GRADE_OUTPUT']);
    expect(value.outputCarrier.packetIdentity).toEqual(value.packetDoc.identity);
    expect(value.outputCarrier.outputReceiptCarrierIdentity).toEqual(value.outputReceipt.identity);
  });

  test('keeps formatted matrix JSON and Markdown answer-key raw while sealing the complete nested rubric carrier into packet bytes', async () => {
    const value = await fixturePromise;
    expect(await contentIdentity(value.rawMatrix)).toEqual(value.rubric.matrixIdentity);
    expect(await contentIdentity(value.rawAnswer)).toEqual(value.rubric.answerKeyIdentity);
    expect(() => parseAuthorityJson(value.rawMatrix)).toThrow('AUTHORITY_JSON_WHITESPACE_FORBIDDEN');
    expect(equalBytes(canonicalDocument(asJson(JSON.parse(new TextDecoder().decode(value.rawMatrix)))), value.rawMatrix)).toBe(false);
    expect(new TextDecoder().decode(value.rawAnswer)).toBe('# Fixture answer key\n');
    expect(value.packet.rubricCarrier).toEqual(value.rubric);
    expect(equalBytes(value.packetDoc.bytes, canonicalDocument(asJson(value.packet)))).toBe(true);
  });

  test('executes private-grammar/material-set/redaction controls without promoting any structural projection to authority', async () => {
    const value = await fixturePromise;
    const itemOne = jsonObject(parseAuthorityJson(value.materialDocOne.bytes));
    const redactedIdentity = identityFromJson(itemOne.redactedMaterialIdentity);
    expect(Object.keys(value.materialSet).sort()).toEqual(['gradeInputArtifactIdentities', 'rootIdentity', 'schemaVersion', 'stateDescriptorIdentity', 'targetLinkIdentity']);
    expect(Object.keys(parseAuthorityJson(value.disclosure.bytes) as object).sort()).toEqual(['gradeMaterialSetIdentity', 'rootIdentity', 'sanitizationPolicyIdentity', 'schemaVersion', 'semanticBrandingTokens', 'treatment', 'visualBrandingTokens']);
    expect(Object.keys(value.rubricBody).sort()).toEqual(['allowedReasonCodes', 'allowedVerdicts', 'answerKeyIdentity', 'contextProfileIdentity', 'instructionsMarkdown', 'matrixIdentity', 'rootIdentity', 'schemaVersion', 'viewportProfileIdentity']);
    expect(value.one.candidate.record.payload.sha256).toBe(redactedIdentity.sha256);
    expect(value.assessment.externalAssessmentReceiptIdentity).toEqual(value.disclosure.identity);
    expect(value.mappingBody.gradeMaterialSetIdentity).toEqual(value.materialSetIdentity);
  });

  test('derives a deterministic local GRADE candidate and canonical pending-review sentinel only from fixture bytes', async () => {
    const value = await fixturePromise;
    const record = value.outputBootstrap.candidate.record;
    const payload = record.payload;
    const { record_id, ...withoutId } = record;
    expect(record.record_family).toBe('GRADE');
    expect(payload.id).toBe(`GRADE:${value.packetDoc.identity.sha256}:${value.outputDoc.identity.sha256}`);
    expect(record.evidence_key).toBe(await recordSha256(asJson({ schema_version: 'MES-EVIDENCE-KEY-1', record_family: 'GRADE', root_identity: value.rootIdentity, grade_run_id: payload.id })));
    expect(record.evidence_key).not.toBe(payload.id);
    expect(record_id).toBe(await recordSha256(asJson(withoutId)));
    expect(record_id).not.toBe(payload.id);
    expect(await recordSha256(asJson({ ...withoutId, evidence_key: payload.id }))).not.toBe(record_id);
    expect(payload.prompt_sha256).toBe(value.packetDoc.identity.sha256);
    expect(payload.output_sha256).toBe(value.outputDoc.identity.sha256);
    expect(payload.artifact_ids).toEqual(['artifact-one', 'artifact-two']);
    expect(record.independent_review.builder_identity).toBe(record.producer_identity.producer_id);
    expect(record.independent_review.reviewer_identity).toBe('UNKNOWN');
    expect(record.independent_review.review_output_identity).toEqual((await doc({ schema_version: 'MES-REVIEW-PENDING-1' })).identity);
  });

  test('runs independent byte-mutation/getter/proxy and frozen-matrix controls before the only absent seam', async () => {
    const value = await fixturePromise;
    const changedPacket = canonicalDocument(asJson({ ...value.packet, rubricCarrier: { ...value.rubric, rubricIdentity: fakeIdentity('f') } }));
    const changedPrefix = new Uint8Array(value.prefix.bytes);
    changedPrefix[0] ^= 1;
    const matrixFamilies = [
      'R5-ACTIVE', 'R5-ROOT-STATE', 'R5-BYTES', 'R5-SNAPSHOT', 'R5-OPAQUE', 'R5-SANITIZE', 'R5-MAP-BRAND', 'R5-RUBRIC',
      'R5-PROMPT', 'R5-GRADER', 'R5-VERDICT', 'R5-DERIVE', 'R5-PENDING', 'R5-BOUNDARY', 'R5-PUBLIC', 'R5-BASELINE',
      'TARGET_CARRIER', 'PRIVATE_GRAMMARS', 'RAW_ROOT_SOURCES', 'OUTPUT_RECEIPT_BOOTSTRAP', 'MUTATION_GETTER_PROXY',
    ];
    const oneRead = Object.defineProperty({}, 'value', { enumerable: true, get: (() => { let reads = 0; return () => ++reads === 1 ? 'captured' : 'changed'; })() });
    const throwingProxy = new Proxy({}, { ownKeys: () => { throw new Error('FIXTURE_PROXY_BOUNDARY'); } });
    expect(matrixFamilies).toHaveLength(21);
    expect(equalBytes(changedPacket, value.packetDoc.bytes)).toBe(false);
    expect(equalBytes(changedPrefix, value.prefix.bytes)).toBe(false);
    expect(await verifyManifestPrefixCarrier(value.rootIdentity, value.prefix.headIdentity, changedPrefix, value.prefix.identity)).toBeNull();
    const changedTarget = new Uint8Array(value.targetOne.bytes);
    changedTarget[0] ^= 1;
    expect(await verifyIntegrationReceiptResolutionCarrier(value.root, value.one.candidate, changedTarget, value.targetOne.identity)).toBeNull();
    expect((oneRead as { value: string }).value).toBe('captured');
    expect(() => Reflect.ownKeys(throwingProxy)).toThrow('FIXTURE_PROXY_BOUNDARY');
    expect(stringsSorted(['N0-D1', 'N0-D1'])).toEqual(['N0-D1']);
  });

  test('keeps the one-field public amendment explicit and all decoded grammars test-private', () => {
    const types = readFileSync(typesPath, 'utf8');
    expect(types.match(/readonly rubricCarrier: VerifiedGradeRubricCarrierV1;/gu)).toHaveLength(1);
    expect(types).not.toMatch(/PrivateGradeMaterialSetPreimageV1|PrivateRedactedGradeMaterialBodyV1|PrivateBrandingDisclosureReceiptBodyV1|PrivateGradeRubricBodyV1|PrivateGradeViewportProfileV1|PrivateGradeContextProfileV1/u);
    expect(existsSync(adapterPath)).toBe(true);
  });
});

describe.skipIf(!existsSync(adapterPath))('Task 5 executable causal adapter cases', () => {
  test('exports the exact async 9/6 transport and provides field-by-field positive packet/candidate oracles', async () => {
    const value = await fixturePromise;
    const api = await adapterApi();
    expect(Object.keys(api).sort()).toEqual(['buildBlindGradePacket', 'prepareBlindGradeCandidate']);
    expect(api.buildBlindGradePacket.length).toBe(9);
    expect(api.prepareBlindGradeCandidate.length).toBe(6);
    const build = buildInput(value);
    const expectedPacket = await deriveExpectedPacketFromRawAuthorities(buildInput(value));
    const pendingPacket = api.buildBlindGradePacket(
      build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity,
      build.materialOne, build.materialTwo, build.mapping, build.branding,
    );
    expect(pendingPacket).toBeInstanceOf(Promise);
    const packet = await assertPositivePacket(
      await pendingPacket,
      expectedPacket,
      [build.prefix.carrierBytes, build.policyBytes],
    );
    const input = candidateInput(value, expectedPacket);
    const expectedCandidate = await deriveExpectedCandidateFromRawAuthorities(candidateInput(value, expectedPacket), expectedPacket);
    const pendingCandidate = api.prepareBlindGradeCandidate(
      input.root, input.packet, input.output, input.prefix, input.materialOne, input.materialTwo,
    );
    expect(pendingCandidate).toBeInstanceOf(Promise);
    await assertPositiveCandidate(
      await pendingCandidate,
      expectedCandidate,
      [input.packet.packetBytes, input.output.carrierBytes, input.prefix.carrierBytes],
    );
    expect(packet.packetIdentity.sha256).toBe(expectedPacket.packetIdentity.sha256);
  });

  test('wrong/stale prefix-head', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    for (const mutate of [(input: Pick<TestBuildInput, 'prefix'>) => { input.prefix.carrierBytes[0] ^= 1; }, (input: Pick<TestBuildInput, 'prefix'>) => { input.prefix.carrierIdentity = fakeIdentity('0'); }]) {
      const input = await freshBuildCase(value); mutate(input);
      expectNonPassing(await api.buildBlindGradePacket(input.root, input.prefix, input.rubric, input.policyBytes, input.policyIdentity, input.materialOne, input.materialTwo, input.mapping, input.branding), 'CONTENT_MISMATCH');
      const candidate = await freshCandidateCase(value); mutate(candidate);
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTENT_MISMATCH');
    }
  });

  test('inactive/corrected/non-GRADE_INPUT material', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    for (const mutate of [(input: Pick<TestBuildInput, 'materialOne'>) => { (input.materialOne as Obj).manifestHeadIdentity = fakeIdentity('0'); }, (input: Pick<TestBuildInput, 'materialOne'>) => { (input.materialOne as Obj).gradeInputArtifactBytesBase64 = '***'; }]) {
      const input = await freshBuildCase(value); mutate(input);
      expectNonPassing(await api.buildBlindGradePacket(input.root, input.prefix, input.rubric, input.policyBytes, input.policyIdentity, input.materialOne, input.materialTwo, input.mapping, input.branding), 'MISSING_SOURCE');
      const candidate = await freshCandidateCase(value); mutate(candidate);
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'MISSING_SOURCE');
    }
  });

  test('material bytes/identity/record/projection mutation', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    for (const mutate of [(input: TestBuildInput) => { input.policyBytes[0] ^= 1; }, (input: TestBuildInput) => { (input.materialOne as Obj).graderMaterialIdentity = fakeIdentity('0'); }]) {
      const input = await freshBuildCase(value); mutate(input);
      expectNonPassing(await api.buildBlindGradePacket(input.root, input.prefix, input.rubric, input.policyBytes, input.policyIdentity, input.materialOne, input.materialTwo, input.mapping, input.branding), 'CONTENT_MISMATCH');
      const candidate = await freshCandidateCase(value);
      candidate.materialOne.graderMaterialIdentity = fakeIdentity('0');
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTENT_MISMATCH');
    }
  });

  test('candidate/mapping mismatch', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const changes = [
      (mapping: Obj) => { mapping.slotMapping = [...(mapping.slotMapping as Obj[])].reverse(); },
      (mapping: Obj) => { mapping.gradeMaterialSetIdentity = fakeIdentity('0'); },
    ];
    for (const change of changes) {
      const input = await freshBuildCase(value);
      await resealMapping(input.mapping, change);
      expectNonPassing(await api.buildBlindGradePacket(input.root, input.prefix, input.rubric, input.policyBytes, input.policyIdentity, input.materialOne, input.materialTwo, input.mapping, input.branding), 'CONTROL_MISMATCH');
      const candidate = await freshCandidateCaseWithResealedMapping(value, change);
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTROL_MISMATCH');
    }
  });

  test('missing/extra/swapped material', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    for (const { mutate, reason } of [
      { mutate: (input: TestBuildInput) => { input.materialOne = structuredClone(input.materialTwo); }, reason: 'CONTROL_MISMATCH' },
      { mutate: (input: TestBuildInput) => { (input.materialTwo as Obj).gradeInputArtifactIdentity = fakeIdentity('0'); }, reason: 'MISSING_SOURCE' },
    ]) {
      const input = await freshBuildCase(value); mutate(input);
      expectNonPassing(await api.buildBlindGradePacket(input.root, input.prefix, input.rubric, input.policyBytes, input.policyIdentity, input.materialOne, input.materialTwo, input.mapping, input.branding), reason);
      const candidate = await freshCandidateCase(value);
      candidate.materialOne = structuredClone(candidate.materialTwo);
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTROL_MISMATCH');
    }
  });

  test('post-call mutation/getter/proxy', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const build = await freshBuildCase(value);
    const expectedPacket = await deriveExpectedPacketFromRawAuthorities(buildInput(value));
    let rootSource = (build.root as Obj).source_identities; let rootGetterReads = 0;
    Object.defineProperty(build.root, 'source_identities', {
      enumerable: true,
      get: () => {
        rootGetterReads += 1;
        if (rootGetterReads > 1) throw new Error('ROOT_GETTER_READ_TWICE');
        return rootSource;
      },
    });
    const pendingBuild = api.buildBlindGradePacket(build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity, build.materialOne, build.materialTwo, build.mapping, build.branding);
    (rootSource as Obj).matrix = fakeIdentity('0');
    rootSource = { ...(rootSource as Obj), matrix: fakeIdentity('0') };
    (build.root as Obj).requirements = [];
    build.prefix.carrierBytes[0] ^= 1; build.prefix.carrierIdentity = fakeIdentity('0'); (build.prefix as Obj).prefix = { changed: true };
    (build.rubric as Obj).matrixBytesBase64 = b64(encoder.encode('{}')); (build.rubric as Obj).matrixIdentity = fakeIdentity('0');
    build.policyBytes[0] ^= 1; new Uint8Array(build.policyBytes.buffer)[0] ^= 1; build.policyIdentity.byte_length = 0; build.policyIdentity.sha256 = '0'.repeat(64);
    (build.materialOne as Obj).graderMaterialBytesBase64 = '***'; (build.materialOne as Obj).graderMaterialIdentity = fakeIdentity('0');
    (build.materialTwo as Obj).stateDescriptorBytesBase64 = '***'; (build.materialTwo as Obj).stateDescriptorIdentity = fakeIdentity('0');
    (build.mapping as Obj).commitmentBytesBase64 = b64(encoder.encode('{}')); (build.mapping as Obj).commitmentIdentity = fakeIdentity('0');
    (build.branding as Obj).assessmentBytesBase64 = b64(encoder.encode('{}')); (build.branding as Obj).assessmentIdentity = fakeIdentity('0');
    (build.branding as Obj).disclosureReceiptBytesBase64 = b64(encoder.encode('{}')); (build.branding as Obj).disclosureReceiptIdentity = fakeIdentity('0');
    await assertPositivePacket(await pendingBuild, expectedPacket, [build.prefix.carrierBytes, build.policyBytes]);
    expect(rootGetterReads).toBe(1);
    const candidate = await freshCandidateCase(value);
    const expectedCandidate = await deriveExpectedCandidateFromRawAuthorities(await freshCandidateCase(value), expectedPacket);
    let packetProjection = candidate.packet.packet; let packetGetterReads = 0;
    Object.defineProperty(candidate.packet, 'packet', {
      enumerable: true,
      get: () => {
        packetGetterReads += 1;
        if (packetGetterReads > 1) throw new Error('PACKET_GETTER_READ_TWICE');
        return packetProjection;
      },
    });
    const pendingCandidate = api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo);
    ((candidate.root as Obj).source_identities as Obj).matrix = fakeIdentity('0');
    (packetProjection as Obj).matrixIdentity = fakeIdentity('0');
    packetProjection = { ...(packetProjection as Obj), matrixIdentity: fakeIdentity('0') } as MutableClone<FrozenBlindGradePacketV1['packet']>;
    candidate.packet.packetBytes[0] ^= 1; new Uint8Array(candidate.packet.packetBytes.buffer)[0] ^= 1; candidate.packet.packetIdentity = fakeIdentity('0');
    candidate.output.carrierBytes[0] ^= 1; new Uint8Array(candidate.output.carrierBytes.buffer)[0] ^= 1; candidate.output.carrierIdentity = fakeIdentity('0');
    candidate.prefix.carrierBytes[0] ^= 1; candidate.prefix.carrierIdentity = fakeIdentity('0'); (candidate.prefix as Obj).prefix = { changed: true };
    (candidate.materialOne as Obj).graderMaterialBytesBase64 = '***'; (candidate.materialOne as Obj).graderMaterialIdentity = fakeIdentity('0');
    (candidate.materialTwo as Obj).stateDescriptorBytesBase64 = '***'; (candidate.materialTwo as Obj).stateDescriptorIdentity = fakeIdentity('0');
    await assertPositiveCandidate(await pendingCandidate, expectedCandidate, [candidate.packet.packetBytes, candidate.output.carrierBytes, candidate.prefix.carrierBytes]);
    expect(packetGetterReads).toBe(1);
    const nestedGetterCandidate = await freshCandidateCase(value);
    const nestedExpected = await deriveExpectedCandidateFromRawAuthorities(await freshCandidateCase(value), expectedPacket);
    let rubricProjection = (nestedGetterCandidate.packet.packet as Obj).rubricCarrier; let nestedGetterReads = 0;
    Object.defineProperty(nestedGetterCandidate.packet.packet, 'rubricCarrier', {
      enumerable: true,
      get: () => {
        nestedGetterReads += 1;
        if (nestedGetterReads > 1) throw new Error('NESTED_PACKET_GETTER_READ_TWICE');
        return rubricProjection;
      },
    });
    const pendingNestedGetter = api.prepareBlindGradeCandidate(
      nestedGetterCandidate.root, nestedGetterCandidate.packet, nestedGetterCandidate.output,
      nestedGetterCandidate.prefix, nestedGetterCandidate.materialOne, nestedGetterCandidate.materialTwo,
    );
    (rubricProjection as Obj).matrixIdentity = fakeIdentity('0');
    rubricProjection = { ...(rubricProjection as Obj), matrixIdentity: fakeIdentity('0') };
    await assertPositiveCandidate(
      await pendingNestedGetter,
      nestedExpected,
      [nestedGetterCandidate.packet.packetBytes, nestedGetterCandidate.output.carrierBytes, nestedGetterCandidate.prefix.carrierBytes],
    );
    expect(nestedGetterReads).toBe(1);
    const accessorBuild = await freshBuildCase(value); let accessorReads = 0;
    Object.defineProperty(accessorBuild.root, 'source_identities', {
      enumerable: true,
      get: () => { accessorReads += 1; throw new Error('ROOT_ACCESSOR_FAILURE'); },
    });
    expectNonPassing(await api.buildBlindGradePacket(accessorBuild.root, accessorBuild.prefix, accessorBuild.rubric, accessorBuild.policyBytes, accessorBuild.policyIdentity, accessorBuild.materialOne, accessorBuild.materialTwo, accessorBuild.mapping, accessorBuild.branding), 'AUTHORITY_MISSING');
    expect(accessorReads).toBe(1);
    const symbolBuild = await freshBuildCase(value); let symbolTrap = 0;
    symbolBuild.materialOne = new Proxy(symbolBuild.materialOne, {
      ownKeys: (target) => { symbolTrap += 1; return [...Reflect.ownKeys(target), Symbol('private')]; },
    });
    expectNonPassing(await api.buildBlindGradePacket(symbolBuild.root, symbolBuild.prefix, symbolBuild.rubric, symbolBuild.policyBytes, symbolBuild.policyIdentity, symbolBuild.materialOne, symbolBuild.materialTwo, symbolBuild.mapping, symbolBuild.branding), 'AUTHORITY_MISSING');
    expect(symbolTrap).toBe(1);
    const prototypeBuild = await freshBuildCase(value); Object.setPrototypeOf(prototypeBuild.materialOne.graderMaterialIdentity, { inherited: true });
    expectNonPassing(await api.buildBlindGradePacket(prototypeBuild.root, prototypeBuild.prefix, prototypeBuild.rubric, prototypeBuild.policyBytes, prototypeBuild.policyIdentity, prototypeBuild.materialOne, prototypeBuild.materialTwo, prototypeBuild.mapping, prototypeBuild.branding), 'AUTHORITY_MISSING');
    let rootTrap = 0;
    const rootProxy = new Proxy((await freshBuildCase(value)).root, { ownKeys: () => { rootTrap += 1; throw new Error('ROOT_PROXY'); } });
    const proxyBuild = await freshBuildCase(value);
    expectNonPassing(await api.buildBlindGradePacket(rootProxy as MutableClone<ExpectedBuildParameters[0]>, proxyBuild.prefix, proxyBuild.rubric, proxyBuild.policyBytes, proxyBuild.policyIdentity, proxyBuild.materialOne, proxyBuild.materialTwo, proxyBuild.mapping, proxyBuild.branding), 'AUTHORITY_MISSING');
    expect(rootTrap).toBe(1);
    let packetTrap = 0;
    const proxyCandidate = await freshCandidateCase(value);
    const packetProxy = new Proxy(proxyCandidate.packet, { ownKeys: () => { packetTrap += 1; throw new Error('PACKET_PROXY'); } });
    expectNonPassing(await api.prepareBlindGradeCandidate(proxyCandidate.root, packetProxy as MutableClone<ExpectedCandidateParameters[1]>, proxyCandidate.output, proxyCandidate.prefix, proxyCandidate.materialOne, proxyCandidate.materialTwo), 'AUTHORITY_MISSING');
    expect(packetTrap).toBe(1);
    const getBuild = await freshBuildCase(value); let getTrap = 0;
    getBuild.materialOne = new Proxy(getBuild.materialOne, {
      get: () => { getTrap += 1; throw new Error('GET_PROXY'); },
    });
    expectNonPassing(await api.buildBlindGradePacket(getBuild.root, getBuild.prefix, getBuild.rubric, getBuild.policyBytes, getBuild.policyIdentity, getBuild.materialOne, getBuild.materialTwo, getBuild.mapping, getBuild.branding), 'AUTHORITY_MISSING');
    expect(getTrap).toBe(1);
    const prototypeProxyCandidate = await freshCandidateCase(value); let prototypeTrap = 0;
    prototypeProxyCandidate.output = new Proxy(prototypeProxyCandidate.output, {
      getPrototypeOf: () => { prototypeTrap += 1; throw new Error('PROTOTYPE_PROXY'); },
    });
    expectNonPassing(await api.prepareBlindGradeCandidate(prototypeProxyCandidate.root, prototypeProxyCandidate.packet, prototypeProxyCandidate.output, prototypeProxyCandidate.prefix, prototypeProxyCandidate.materialOne, prototypeProxyCandidate.materialTwo), 'AUTHORITY_MISSING');
    expect(prototypeTrap).toBe(1);
    const keyShapeBuild = await freshBuildCase(value); let keyShapeTrap = 0;
    keyShapeBuild.materialTwo = new Proxy(keyShapeBuild.materialTwo, {
      ownKeys: (target) => { keyShapeTrap += 1; return [...Reflect.ownKeys(target), 'unexpected']; },
    });
    expectNonPassing(await api.buildBlindGradePacket(keyShapeBuild.root, keyShapeBuild.prefix, keyShapeBuild.rubric, keyShapeBuild.policyBytes, keyShapeBuild.policyIdentity, keyShapeBuild.materialOne, keyShapeBuild.materialTwo, keyShapeBuild.mapping, keyShapeBuild.branding), 'AUTHORITY_MISSING');
    expect(keyShapeTrap).toBe(1);
    const extraKeyBuild = await freshBuildCase(value);
    (extraKeyBuild.root as Obj).unapproved = true;
    expectNonPassing(await api.buildBlindGradePacket(extraKeyBuild.root, extraKeyBuild.prefix, extraKeyBuild.rubric, extraKeyBuild.policyBytes, extraKeyBuild.policyIdentity, extraKeyBuild.materialOne, extraKeyBuild.materialTwo, extraKeyBuild.mapping, extraKeyBuild.branding), 'AUTHORITY_MISSING');
    const nestedProxy = await freshCandidateCase(value); let descriptorTrap = 0;
    nestedProxy.materialOne.graderMaterialIdentity = new Proxy(nestedProxy.materialOne.graderMaterialIdentity, {
      getOwnPropertyDescriptor: () => { descriptorTrap += 1; throw new Error('NESTED_IDENTITY_PROXY'); },
    });
    expectNonPassing(await api.prepareBlindGradeCandidate(nestedProxy.root, nestedProxy.packet, nestedProxy.output, nestedProxy.prefix, nestedProxy.materialOne, nestedProxy.materialTwo), 'AUTHORITY_MISSING');
    expect(descriptorTrap).toBe(1);
  });

  test('target/output carrier proof drift', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const build = await freshBuildCase(value); (build.materialOne as Obj).targetReceiptCarrierBytesBase64 = b64(encoder.encode('{}'));
    expectNonPassing(await api.buildBlindGradePacket(build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity, build.materialOne, build.materialTwo, build.mapping, build.branding), 'TARGET_MISMATCH');
    const fourth = await fixture(true);
    expect(await verifyIntegrationReceiptResolutionCarrier(fourth.root, fourth.one.candidate, fourth.targetOne.bytes, fourth.targetOne.identity)).not.toBeNull();
    const fourthBuild = await freshBuildCase(fourth);
    expectNonPassing(await api.buildBlindGradePacket(fourthBuild.root, fourthBuild.prefix, fourthBuild.rubric, fourthBuild.policyBytes, fourthBuild.policyIdentity, fourthBuild.materialOne, fourthBuild.materialTwo, fourthBuild.mapping, fourthBuild.branding), 'TARGET_MISMATCH');
    const fourthPacketBody: BlindGradePacketBodyV1 = {
      schemaVersion: 'MES-BLIND-GRADE-PACKET-1',
      rootIdentity: fourth.rootIdentity,
      targetLinkIdentity: (await doc(fourth.targetLink)).identity,
      stateDescriptorIdentity: fourth.materialOne.stateDescriptorIdentity,
      gradeMaterialSetIdentity: fourth.materialSetIdentity,
      matrixIdentity: fourth.rubric.matrixIdentity,
      answerKeyIdentity: fourth.rubric.answerKeyIdentity,
      rubricIdentity: fourth.rubric.rubricIdentity,
      rubricCarrier: fourth.rubric,
      sanitizationPolicyIdentity: fourth.policyDoc.identity,
      brandingAssessmentIdentity: fourth.assessmentDoc.identity,
      mappingCommitmentIdentity: fourth.mappingDoc.identity,
      items: [
        gradeMaterialFromJson(parseAuthorityJson(fourth.materialDocOne.bytes)),
        gradeMaterialFromJson(parseAuthorityJson(fourth.materialDocTwo.bytes)),
      ],
    };
    const fourthPacket = {
      packet: fourthPacketBody,
      packetBytes: new Uint8Array(fourth.packetDoc.bytes),
      packetIdentity: structuredClone(fourth.packetDoc.identity),
    } as FrozenBlindGradePacketV1;
    const fourthCandidate = candidateInput(fourth, fourthPacket);
    expectNonPassing(await api.prepareBlindGradeCandidate(fourthCandidate.root, fourthCandidate.packet, fourthCandidate.output, fourthCandidate.prefix, fourthCandidate.materialOne, fourthCandidate.materialTwo), 'TARGET_MISMATCH');
    for (const { alter, reason } of [
      { alter: (input: TestCandidateInput) => { input.output.carrierBytes[0] ^= 1; }, reason: 'CONTENT_MISMATCH' },
      { alter: (input: TestCandidateInput) => { (input.materialTwo as Obj).targetReceiptCarrierIdentity = fakeIdentity('0'); }, reason: 'TARGET_MISMATCH' },
    ]) {
      const candidate = await freshCandidateCase(value); alter(candidate);
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), reason);
    }
  });

  test('raw root source substitution', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const matrixSubstitution = await fixture({ rootMatrixIdentity: fakeIdentity('0') });
    const build = await freshBuildCase(matrixSubstitution);
    expectNonPassing(await api.buildBlindGradePacket(build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity, build.materialOne, build.materialTwo, build.mapping, build.branding), 'CONTENT_MISMATCH');
    const answerSubstitution = await fixture({ rootAnswerKeyIdentity: fakeIdentity('0') });
    const candidate = await freshCandidateCase(answerSubstitution);
    expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTENT_MISMATCH');
  });

  test('private grammar/redaction drift', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const mutate = async (input: Pick<TestBuildInput, 'materialOne'>) => {
      const material = parseAuthorityJson(Buffer.from((input.materialOne as Obj).graderMaterialBytesBase64 as string, 'base64')) as Obj;
      const settled = await doc({ ...material, builder_identity: 'forbidden' });
      (input.materialOne as Obj).graderMaterialBytesBase64 = b64(settled.bytes);
      (input.materialOne as Obj).graderMaterialIdentity = settled.identity;
    };
    const build = await freshBuildCase(value); await mutate(build);
    expectNonPassing(await api.buildBlindGradePacket(build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity, build.materialOne, build.materialTwo, build.mapping, build.branding), 'PRIVACY_BOUNDARY');
    const candidate = await freshCandidateCase(value); await mutate(candidate);
    expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'PRIVACY_BOUNDARY');
    for (const privacyFixture of [
      await fixture({ oneContentMarkdown: 'Builder report: private_canary unlicensed-branding.\n' }),
      await fixture({
        oneContentMarkdown: 'licensed-semantic\n', semanticBrandingTokens: ['licensed-semantic'], visualBrandingTokens: ['licensed-visual'],
        oneDisclosureTokens: ['licensed-semantic'], twoDisclosureTokens: [],
      }),
      await fixture({ oneContentMarkdown: 'licensed-semantic\n', semanticBrandingTokens: ['licensed-semantic'] }),
    ]) {
      const privacyBuild = await freshBuildCase(privacyFixture);
      expectNonPassing(await api.buildBlindGradePacket(privacyBuild.root, privacyBuild.prefix, privacyBuild.rubric, privacyBuild.policyBytes, privacyBuild.policyIdentity, privacyBuild.materialOne, privacyBuild.materialTwo, privacyBuild.mapping, privacyBuild.branding), 'PRIVACY_BOUNDARY');
      const privacyCandidate = await freshCandidateCase(privacyFixture);
      expectNonPassing(await api.prepareBlindGradeCandidate(privacyCandidate.root, privacyCandidate.packet, privacyCandidate.output, privacyCandidate.prefix, privacyCandidate.materialOne, privacyCandidate.materialTwo), 'PRIVACY_BOUNDARY');
    }
  });

  test('nested rubric carrier/hidden prompt drift', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const build = await freshBuildCase(value); (build.rubric as Obj).hiddenPrompt = 'forbidden';
    expectNonPassing(await api.buildBlindGradePacket(build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity, build.materialOne, build.materialTwo, build.mapping, build.branding), 'CONTENT_MISMATCH');
    const candidate = await freshCandidateCase(value); ((candidate.packet as Obj).packet as Obj).matrixIdentity = fakeIdentity('0');
    expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTENT_MISMATCH');
  });

  test('grader/verdict/pending drift', async () => {
    const value = await fixturePromise; const api = await adapterApi();
    const build = await freshBuildCase(value);
    const expectedPacket = await deriveExpectedPacketFromRawAuthorities(buildInput(value));
    await assertPositivePacket(
      await api.buildBlindGradePacket(build.root, build.prefix, build.rubric, build.policyBytes, build.policyIdentity, build.materialOne, build.materialTwo, build.mapping, build.branding),
      expectedPacket,
      [build.prefix.carrierBytes, build.policyBytes],
    );
    for (const alter of [
      (output: Obj) => { output.verdict = 'A CLEARLY BETTER'; },
      (output: Obj) => { output.reasonCodes = ['PRIVACY_PARITY']; },
    ]) {
      const candidate = await freshCandidateCase(value); candidate.output = await resealOutputChain(value, alter);
      const expected = await deriveExpectedCandidateFromRawAuthorities(candidate, expectedPacket);
      await assertPositiveCandidate(
        await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo),
        expected,
        [candidate.packet.packetBytes, candidate.output.carrierBytes, candidate.prefix.carrierBytes],
      );
    }
    for (const alter of [
      (output: Obj) => { output.independent_review = { reviewer_identity: 'copied' }; },
      (_output: Obj, outer: Obj) => { outer.pendingIndependentReview = { reviewer_identity: 'copied' }; },
      (_output: Obj, outer: Obj) => { outer.status = 'REVIEWED'; },
    ]) {
      const candidate = await freshCandidateCase(value); candidate.output = await resealOutputChain(value, alter);
      expectNonPassing(await api.prepareBlindGradeCandidate(candidate.root, candidate.packet, candidate.output, candidate.prefix, candidate.materialOne, candidate.materialTwo), 'CONTROL_MISMATCH');
    }
    const source = readFileSync(adapterPath, 'utf8');
    const exports = [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gmu)].map((match) => match[1]).sort();
    const imports = [...source.matchAll(/\bfrom\s+'([^']+)'/gu)].map((match) => match[1]).sort();
    expect(exports).toEqual(['buildBlindGradePacket', 'prepareBlindGradeCandidate']);
    expect(Object.keys(api).sort()).toEqual(exports);
    expect(imports).toEqual([
      './canonical-json', './evidence-spine-manifest', './evidence-spine-types',
      './evidence-spine-validation', './identity', './product-receipts', 'node:buffer',
    ]);
    expect(source).toContain('verifyManifestPrefixCarrier');
    expect(source).toContain('verifyIntegrationReceiptResolutionCarrier');
    const buildBody = source.slice(source.indexOf('export async function buildBlindGradePacket'), source.indexOf('export async function prepareBlindGradeCandidate'));
    const candidateBody = source.slice(source.indexOf('export async function prepareBlindGradeCandidate'));
    expect(buildBody.indexOf('strictDecodeBase64Graph')).toBeGreaterThan(buildBody.indexOf('snapshotBuild'));
    expect(buildBody.indexOf('strictDecodeBase64Graph')).toBeLessThan(buildBody.indexOf('await'));
    expect(candidateBody.indexOf('strictDecodeBase64Graph')).toBeGreaterThan(candidateBody.indexOf('snapshotCandidate'));
    expect(candidateBody.indexOf('strictDecodeBase64Graph')).toBeLessThan(candidateBody.indexOf('await'));
    withAdapterModuleCensus((adapterModuleCensus) => {
      const census = adapterModuleCensus(source);
      expect(census.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
      expect(census.unapprovedRuntimeBindings).toEqual([]);
      expect(census.moduleStateBindings).toEqual([]);
      expect(census.unsupportedTopLevelStatements).toEqual([]);
      expect(census.faultEnd).toBeGreaterThan(0);
      for (const forbiddenRuntimeAuthority of [
        'globalThis', 'window', 'self', 'document', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        'crypto', 'getRandomValues', 'randomUUID', 'Math', 'Date', 'performance', 'process', 'env',
        'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'Worker', 'D1Database',
        'writeFile', 'appendFile', 'child_process', 'WeakMap', 'WeakSet', 'require', 'eval', 'Function',
        'integrateReviewedCandidate', 'prepareReviewedManifestAppend', 'deriveManifestAppend',
        'capabilityToken', 'authorityBrand', 'authorityCache', 'authorityRegistry', 'callerReadableSecret', 'markerProperty', 'Symbol',
      ]) expect(census.identifiers).not.toContain(forbiddenRuntimeAuthority);
      expect(census.dynamicImportCount).toBe(0);
      expect(census.forbiddenMutationCalls).toEqual([]);
      expect(acceptsAdapterModuleCensus(census)).toBe(true);
      for (const [binding, initializer, state] of [
        ['state', 'new Map()', 'state:Map'],
        ['cache', 'new Set()', 'cache:Set'],
        ['weakRegistry', 'new WeakMap()', 'weakRegistry:WeakMap'],
        ['weakRegistry', 'new WeakSet()', 'weakRegistry:WeakSet'],
        ['authorityRegistry', 'Object.create(null)', 'authorityRegistry:Object.create'],
        ['token', 'Symbol(\'in-memory\')', 'token:Symbol'],
        ['brand', '{}', 'brand:object'],
        ['hiddenAuthority', '{}', 'hiddenAuthority:object'],
      ] as const) {
        const injectedModuleState = `${source.slice(0, census.faultEnd)}\nconst ${binding} = ${initializer};\n${source.slice(census.faultEnd)}`;
        const injectedCensus = adapterModuleCensus(injectedModuleState);
        expect(injectedCensus.runtimeBindings).toContain(binding);
        expect(injectedCensus.unapprovedRuntimeBindings).toContain(binding);
        expect(injectedCensus.moduleStateBindings).toContain(state);
        expect(acceptsAdapterModuleCensus(injectedCensus)).toBe(false);
      }
      const injectedStaticState = `${source.slice(0, census.faultEnd)}\nclass State { static cache = new Map(); }\n${source.slice(census.faultEnd)}`;
      const injectedStaticCensus = adapterModuleCensus(injectedStaticState);
      expect(injectedStaticCensus.moduleStateBindings).toContain('static:State:cache');
      expect(acceptsAdapterModuleCensus(injectedStaticCensus)).toBe(false);
      const canonicalDeclaration = 'const canonical = (value: CanonicalJsonValue): Uint8Array => canonicalDocument(value);';
      expect(source.split(canonicalDeclaration)).toHaveLength(2);
      const retainedGetterSource = source.replace(canonicalDeclaration, `class State {
        static get canonical() {
          const memo = new Map();
          return (value: CanonicalJsonValue): Uint8Array => {
            memo.set(value, true);
            return canonicalDocument(value);
          };
        }
      }
      const canonical = State.canonical;`);
      const retainedGetterCensus = adapterModuleCensus(retainedGetterSource);
      expect(retainedGetterCensus.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
      expect.soft(retainedGetterCensus.moduleStateBindings.length, 'retained static getter Map').toBeGreaterThan(0);
      expect.soft(acceptsAdapterModuleCensus(retainedGetterCensus), 'retained static getter Map').toBe(false);
      expect(retainedGetterCensus.moduleStateBindings).toContain('retained:memo:NewExpression');
      for (const [name, initializer] of [
        ['memo', 'new Set()'], ['memo', 'new WeakMap()'], ['memo', 'new WeakSet()'],
        ['registry', 'Object.create(null)'], ['token', 'Symbol()'], ['brand', '{ value: true }'],
        ['hiddenAuthority', '{ proof: null }'], ['items', '[]'], ['epoch', '0'],
      ] as const) {
        const getterSource = source.replace(canonicalDeclaration, `class State {
          static get canonical() {
            const ${name} = ${initializer};
            return (value: CanonicalJsonValue): Uint8Array => { void ${name}; return canonicalDocument(value); };
          }
        }
        const canonical = State["canonical"];`);
        const getterCensus = adapterModuleCensus(getterSource);
        expect(getterCensus.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
        expect.soft(getterCensus.moduleStateBindings.some((finding) => finding.startsWith(`retained:${name}:`)), `getter ${initializer}`).toBe(true);
        expect.soft(acceptsAdapterModuleCensus(getterCensus), `getter ${initializer}`).toBe(false);
      }
      const capturedFunction = `const memo = new Map(); const saved = memo;
        const project = (value: CanonicalJsonValue): Uint8Array => { void saved; return canonicalDocument(value); };
        const returned = project;`;
      for (const [members, read] of [
        [`static get canonical() { ${capturedFunction} return returned; }`, 'State.canonical'],
        [`static get canonical() { const source = State; const key = "closure"; return source[key]; }
          static get ["closure"]() { ${capturedFunction} return returned; }`, 'State["canonical"]'],
        [`static get canonical() { const source = this; return source.closure; }
          static get closure() { ${capturedFunction} return returned; }`, 'State.canonical'],
        [`static get payload() { ${capturedFunction} return { canonical: returned }; }`, 'State.payload["canonical"]'],
        [`static get payload() { ${capturedFunction} return { get canonical() { return returned; } }; }`, 'State["payload"].canonical'],
      ] as const) {
        const aliasCensus = adapterModuleCensus(source.replace(canonicalDeclaration,
          `class State { ${members} } const canonical = ${read};`));
        expect(aliasCensus.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
        expect.soft(aliasCensus.moduleStateBindings).toContain('retained:saved:NewExpression');
        expect.soft(acceptsAdapterModuleCensus(aliasCensus), read).toBe(false);
      }
      for (const declaration of [
        'const canonical = canonicalDocument;',
        `class State { static get canonical() { const imported = canonicalDocument; return imported; } }
          const canonical = State.canonical;`,
        `class State { static get payload() { return { canonical: canonicalDocument }; } }
          const canonical = State.payload["canonical"];`,
        `class State { static project(value: CanonicalJsonValue) { const seen = new Set(); seen.add(value); return canonicalDocument(value); } }
          const canonical = State["project"];`,
        `class State {
          static get canonical() { const source = this; return source.project; }
          static project(value: CanonicalJsonValue) { const seen = new Set(); seen.add(value); return canonicalDocument(value); }
        } const canonical = State.canonical;`,
        `class State { static get canonical() { const seen = new Set(); seen.add("local"); return canonicalDocument; } }
          const canonical = State.canonical;`,
      ]) {
        const pureCensus = adapterModuleCensus(source.replace(canonicalDeclaration, declaration));
        expect(pureCensus.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
        expect.soft(pureCensus.moduleStateBindings, declaration).toEqual([]);
        expect.soft(acceptsAdapterModuleCensus(pureCensus), declaration).toBe(true);
      }
      for (const [name, initializer] of [
        ['memo', 'new Map()'], ['memo', 'new Set()'], ['memo', 'new WeakMap()'], ['memo', 'new WeakSet()'],
        ['registry', 'Object.create(null)'], ['token', 'Symbol()'], ['brand', '{}'], ['hiddenAuthority', '{ count: 0 }'],
        ['innocent', '[]'], ['innocent', "'retained-token'"],
      ]) {
        const closureSource = source.replace(canonicalDeclaration, `const canonical = (() => {
          const ${name} = ${initializer};
          return (value: CanonicalJsonValue): Uint8Array => { void ${name}; return canonicalDocument(value); };
        })();`);
        const closureCensus = adapterModuleCensus(closureSource);
        expect(closureCensus.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
        expect.soft(closureCensus.moduleStateBindings.length, `closure ${name}: ${initializer}`).toBeGreaterThan(0);
        expect.soft(acceptsAdapterModuleCensus(closureCensus), `closure ${name}: ${initializer}`).toBe(false);
      }
      for (const member of [
        'static get cache() { return this._cache || (this._cache = new Map()); }',
        'static get cache() { return State._cache ??= new Map(); }',
        'static remember(value: unknown) { (this._cache ??= new Map()).set(value, true); }',
        'static set cache(value: unknown) { this._cache = value; }',
        'static remember(value: unknown) { globalThis.saved = value; }',
        'static remember(value: unknown) { const alias = this; (alias._cache ??= new Map()).set(value, true); }',
        'static remember(value: unknown) { const alias = State; alias._cache = new Map(); }',
        'static remember(value: unknown) { const local = new Map(); State._cache = local; }',
        'static remember(value: unknown) { let alias = {}; alias = State; alias._cache = new Map(); }',
        'static remember(value: unknown) { const alias = value ? this : {}; alias._cache = new Map(); }',
        'static { this._cache = new Map(); }',
      ]) {
        const staticSource = `${source.slice(0, census.faultEnd)}\nclass State { ${member} }\n${source.slice(census.faultEnd)}`;
        const staticCensus = adapterModuleCensus(staticSource);
        expect(staticCensus.runtimeBindings).toEqual(approvedAdapterRuntimeBindings);
        expect.soft(staticCensus.moduleStateBindings.length, member).toBeGreaterThan(0);
        expect.soft(acceptsAdapterModuleCensus(staticCensus), member).toBe(false);
      }
      const injectedPerCallSet = `${source.slice(0, census.faultEnd)}\nfunction localCycleGuard() { const seen = new Set<string>(); return seen; }\n${source.slice(census.faultEnd)}`;
      const perCallCensus = adapterModuleCensus(injectedPerCallSet);
      expect(perCallCensus.unapprovedRuntimeBindings).toEqual([]);
      expect(perCallCensus.moduleStateBindings).toEqual([]);
      expect(acceptsAdapterModuleCensus(perCallCensus)).toBe(true);
      const localStaticCensus = adapterModuleCensus(`${source}\nclass Local {
        static hasCycle(value: string) { const seen = new Set<string>(); seen.add(value); return seen.has(value); }
      }`);
      expect(localStaticCensus.moduleStateBindings).toEqual([]);
      expect(acceptsAdapterModuleCensus(localStaticCensus)).toBe(true);
    });
    const types = readFileSync(typesPath, 'utf8');
    expect(Buffer.byteLength(types)).toBe(41_522);
    expect(await contentIdentity(encoder.encode(types))).toEqual({ byte_length: 41_522, sha256: 'd24a23ff628ad19e98a9d3e5f9be21fa58048047bea135240e69c9107a8c1190' });
    expect(types.match(/readonly rubricCarrier: VerifiedGradeRubricCarrierV1;/gu)).toHaveLength(1);
    const barrel = readFileSync(barrelPath, 'utf8');
    expect(Buffer.byteLength(barrel)).toBe(2_708);
    expect(await contentIdentity(encoder.encode(barrel))).toEqual({ byte_length: 2_708, sha256: '46c94a7f42d5eb359c34d27bc1515582c30da3c84519a206fcdc83c90e134685' });
    expect(barrel).not.toMatch(/blind-grade-adapter|buildBlindGradePacket|prepareBlindGradeCandidate/u);
  });
});

describe('Task 5 augmented causal RED seam', () => {
  test('requires the complete absent adapter API only after all independent controls pass', async () => {
    const value = await fixturePromise;
    expect(value.prefix.verified.prefix.status).toBe('VERIFIED');
    expect(value.packetDoc.identity).toEqual(await contentIdentity(value.packetDoc.bytes));
    expect(existsSync(adapterPath)).toBe(true);
  });
});
