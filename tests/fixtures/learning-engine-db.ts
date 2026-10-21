import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export function createLearningEngineDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE training_turns (id TEXT PRIMARY KEY);');
  for (const migration of ['0004_p2_scaffolding_hooks.sql', '0008_math_engines_v9.sql']) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  sqlite.exec("INSERT INTO sessions (id) VALUES ('session-a'), ('session-b')");
  return wrapLearningEngineDatabase(sqlite);
}

export function createMigratedLearningDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../../migrations/', import.meta.url);
  try {
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    return wrapLearningEngineDatabase(sqlite);
  } catch (error) { sqlite.close(); throw error; }
}

function wrapLearningEngineDatabase(sqlite: DatabaseSync) {
  const failures: string[] = [];
  const db = {
    prepare(sql: string) {
      function preparedStatement(values: SQLInputValue[] = []) {
      const statement = {
        bind(...bound: SQLInputValue[]) { return preparedStatement([...bound]); },
        async run() {
          try {
            const prepared = sqlite.prepare(sql);
            if (prepared.columns().length > 0) return { success: true, results: prepared.all(...values), meta: {} };
            const result = prepared.run(...values);
            return { success: true, results: [], meta: { changes: Number(result.changes) } };
          }
          catch (error) { failures.push(`${sql} :: ${String(error)}`); throw error; }
        },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...values), meta: {} }; },
      };
      return statement;
      }
      return preparedStatement();
    },
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { sqlite, db, failures };
}

