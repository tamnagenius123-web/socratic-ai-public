const TEMPLATE_PLACEHOLDER = /\{\{([^{}]+)\}\}/g;
const TEMPLATE_KEY = /^[A-Z0-9_]+$/;

/** Renders only explicit, uppercase prompt-template placeholders. */
export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (placeholder, key: string) => {
    if (!TEMPLATE_KEY.test(key) || !Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`PROMPT_TEMPLATE_VALUE_MISSING:${key || placeholder}`);
    }
    return values[key];
  });
}
