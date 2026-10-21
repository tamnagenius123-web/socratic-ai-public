import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const catalogTables = [
  'tutor_service_hooks', 'tutor_policy_q_table', 'micro_indicator_catalog', 'category_hierarchy',
  'growth_path_revisions', 'growth_capability_definitions', 'growth_observation_rules',
  'growth_gap_rules', 'growth_practice_rules', 'growth_lifecycle_transitions',
  'growth_lifecycle_transition_contracts', 'growth_lifecycle_catalog_upgrade',
];

/** Compile the reviewed fresh-database derivatives, never an existing application database. */
export function prepareLocalSchema() {
  const database = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    const directory = new URL('../migrations/', import.meta.url);
    const files = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
    const migrationFiles=files.map((name)=>{
      const bytes=readFileSync(new URL(name,directory));database.exec(bytes.toString('utf8'));
      return {name,sha256:createHash('sha256').update(bytes).digest('hex')};
    });
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('LOCAL_SCHEMA_FOREIGN_KEY_VIOLATION');
    const objects = database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const definitions = objects.filter((object) => object.type !== 'trigger').sort((a,b) => {
      const order = { table:0, index:1, view:2 }; return order[a.type]-order[b.type] || a.name.localeCompare(b.name);
    }).map((object) => object.sql);
    const triggers = objects.filter((object) => object.type === 'trigger').map((object) => object.sql);
    const existingTables = new Set(objects.filter((object)=>object.type==='table').map((object)=>object.name));
    const catalogs = catalogTables.filter((table)=>existingTables.has(table)).flatMap((table) => database.prepare(`SELECT * FROM "${table}"`).all().map((row) => ({ table, row })));
    for (const table of ['users','books','sessions','messages','training_sessions','training_turns','training_messages','document_chunks']) {
      if (database.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count !== 0) throw new Error('LOCAL_SCHEMA_CONTAINS_PERSONAL_OR_CONTENT_ROWS');
    }
    return { files:files.length, migrationFiles, tables:objects.filter((object) => object.type==='table').length, definitions, catalogs, triggers };
  } finally { database.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const schema = prepareLocalSchema();
  console.log(JSON.stringify({ migrationFiles:schema.files, tables:schema.tables, catalogRows:schema.catalogs.length, personalContentRows:0 }));
}
