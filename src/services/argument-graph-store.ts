export type ArgumentGraphScope = 'sparring' | 'training';

export interface ArgumentGraphTables {
  nodes: 'argument_nodes' | 'training_argument_nodes';
  edges: 'argument_edges' | 'training_argument_edges';
}

const SPARRING_GRAPH_TABLES: ArgumentGraphTables = {
  nodes: 'argument_nodes',
  edges: 'argument_edges',
};

const TRAINING_GRAPH_TABLES: ArgumentGraphTables = {
  nodes: 'training_argument_nodes',
  edges: 'training_argument_edges',
};

/** Table names are selected only from this internal allowlist. */
export function argumentGraphTables(scope: ArgumentGraphScope = 'sparring'): ArgumentGraphTables {
  if (scope === 'sparring') return SPARRING_GRAPH_TABLES;
  if (scope === 'training') return TRAINING_GRAPH_TABLES;
  throw new Error('Unsupported argument graph scope.');
}
