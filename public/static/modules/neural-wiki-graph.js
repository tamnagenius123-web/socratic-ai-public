// Socratic AI v35 — Neural Wiki Force-Directed Graph Visualization
// D3.js v7 + User-specific synapse weights + Mastery-based styling
// References: D3 force simulation, Taiji engine integration

const D3_CDN = 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

let d3Module = null;

async function loadD3() {
  if (d3Module) return d3Module;
  try {
    d3Module = await import(D3_CDN);
    return d3Module;
  } catch (e) {
    console.error('[Neural Wiki] D3.js load failed:', e);
    return null;
  }
}

/**
 * Calculate node radius based on mastery level
 * Formula: 8 + log(mastery × 20)
 * @param {number} mastery - Mastery score (0~1)
 * @returns {number} Radius in pixels
 */
export function calculateNodeRadius(mastery) {
  if (typeof mastery !== 'number' || mastery < 0) return 8;
  return 8 + Math.log(Math.max(mastery * 20, 1));
}

/**
 * Map mastery level to color using design tokens
 * mastery ≥ 0.8 → --signal-progress (green)
 * 0.3~0.8 → --ink-primary (black)
 * <0.3 → --ink-tertiary (gray)
 * @param {number} mastery - Mastery score (0~1)
 * @param {object} cssVariables - CSS var name map (for testing)
 * @returns {string} CSS variable name or fallback color
 */
export function mapMasteryToColor(mastery, cssVariables = {}) {
  const defaultVars = {
    high: '--signal-progress',
    medium: '--ink-primary',
    low: '--ink-tertiary',
  };
  const vars = { ...defaultVars, ...cssVariables };

  if (typeof mastery !== 'number') {
    return 'var(--ink-disabled)';
  } else if (mastery >= 0.8) {
    return `var(${vars.high})`;
  } else if (mastery >= 0.3) {
    return `var(${vars.medium})`;
  } else {
    return `var(${vars.low})`;
  }
}

/**
 * Render interactive neural wiki force-directed graph
 * @param {string} containerId - DOM container ID
 * @param {object} graphData - Graph data with nodes, edges, synapses
 * @param {object} options - Rendering options
 *   - width: number
 *   - height: number
 *   - onNodeClick: callback(nodeId, nodeData)
 *   - taijiActive: boolean (show pulse ring on antipodal nodes)
 *   - taijiAntipodes?: [nodeId1, nodeId2]
 */
export async function renderNeuralWikiGraph(containerId, graphData, options = {}) {
  const d3 = await loadD3();
  if (options.isCurrent?.() === false) return;
  if (!d3) {
    console.warn('[Neural Wiki] D3 not available');
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) {
    console.error('[Neural Wiki] Container not found:', containerId);
    return;
  }

  // Clear previous content
  container.innerHTML = '';

  const width = options.width || container.clientWidth || 800;
  const height = options.height || Math.max(400, container.clientHeight || 600);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const onNodeClick = options.onNodeClick || (() => {});
  const taijiActive = options.taijiActive || false;
  const taijiAntipodes = options.taijiAntipodes || [];

  // Prepare nodes
  const nodes = (graphData.nodes || []).map((n, i) => ({
    id: n.id,
    concept: n.concept || '',
    description: n.description || '',
    bloomLevel: n.bloomLevel || 'K1',
    coreEssence: n.coreEssence || '',
    buildingBlocks: n.buildingBlocks || {},
    metaphoricalBridges: n.metaphoricalBridges || {},
    mastery: typeof n.mastery === 'number' ? n.mastery : null,
    radius: calculateNodeRadius(typeof n.mastery === 'number' ? n.mastery : 0),
  }));

  // Prepare edges (synapse weights as link strength)
  const nodeIds = new Set(nodes.map(n => n.id));

  // Create synapse weight map for faster lookup
  const synapseWeightMap = {};
  (graphData.synapses || []).forEach(syn => {
    const key = `${syn.fromId}→${syn.toId}`;
    if (typeof syn.synapseWeight === 'number') synapseWeightMap[key] = syn.synapseWeight;
  });

  const links = (graphData.edges || []).filter(e =>
    nodeIds.has(e.fromId) && nodeIds.has(e.toId)
  ).map((e, i) => ({
    source: e.fromId,
    target: e.toId,
    relationType: e.relationType || 'related',
    strength: typeof e.strength === 'number' ? e.strength : null,
    // User-specific synapse weight
    synapseWeight: synapseWeightMap[`${e.fromId}→${e.toId}`] ?? null,
  }));

  if (nodes.length === 0) {
    container.innerHTML = `<div class="flex items-center justify-center h-full text-gray-400 text-sm">
      <i class="fas fa-project-diagram mr-2"></i>뉴럴 위키 그래프 데이터가 없습니다.
    </div>`;
    return { empty: true, nodes: [], links: [] };
  }

  // Create SVG
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height])

  // Defs for markers and filters
  const defs = svg.append('defs');

  // Arrow marker
  defs.append('marker')
    .attr('id', 'arrow-default')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', isDark ? 'var(--ink-secondary)' : 'var(--ink-tertiary)');

  // Drop shadow filter
  const shadowFilter = defs.append('filter')
    .attr('id', 'node-shadow')
    .attr('x', '-20%')
    .attr('y', '-20%')
    .attr('width', '140%')
    .attr('height', '140%');
  shadowFilter.append('feDropShadow')
    .attr('dx', 0)
    .attr('dy', 2)
    .attr('stdDeviation', 2.5)
    .attr('flood-opacity', 0.12);


  // Force simulation parameters
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links)
      .id(d => d.id)
      .distance(50)
      .strength(0.4))
    .force('charge', d3.forceManyBody()
      .strength(-200)
      .distanceMax(300))
    .force('center', d3.forceCenter(width / 2, height / 2)
      .strength(0.05))
    .force('collision', d3.forceCollide()
      .radius(d => d.radius + 8)
      .iterations(2));

  // Zoom behavior
  const g = svg.append('g');
  const zoom = d3.zoom()
    .scaleExtent([0.5, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  svg.call(zoom);

  // Links (edges)
  const link = g.append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', isDark ? 'var(--ink-tertiary)' : 'var(--surface-2)')
    .attr('stroke-width', d => 1.5)
    .attr('opacity', d => d.synapseWeight === null ? 0.2 : Math.min(d.synapseWeight, 0.9))
    .attr('marker-end', 'url(#arrow-default)');

  // Nodes
  const node = g.append('g')
    .attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      onNodeClick(d.id, d);
    })
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      })
    );

  // Node circles
  node.append('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => mapMasteryToColor(d.mastery))
    .attr('stroke', isDark ? 'var(--surface-2)' : 'var(--surface-0)')
    .attr('stroke-width', 2)
    .attr('filter', 'url(#node-shadow)')
    .attr('opacity', 0.9);

  // Node labels (concept text)
  node.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('fill', isDark ? 'var(--surface-0)' : 'var(--ink-primary)')
    .attr('font-size', '11px')
    .attr('font-weight', '600')
    .attr('pointer-events', 'none')
    .text(d => {
      const concept = d.concept || '';
      return concept.length > 12 ? concept.substring(0, 10) + '..' : concept;
    });

  // Taiji antipodal pulse rings
  if (taijiActive && taijiAntipodes.length > 0) {
    taijiAntipodes.forEach(antipodeId => {
      const antipodeNode = nodes.find(n => n.id === antipodeId);
      if (antipodeNode) {
        node.filter(d => d.id === antipodeId)
          .append('circle')
          .attr('r', d => d.radius)
          .attr('fill', 'none')
          .attr('stroke', 'var(--signal-friction)')
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '4,3')
          .attr('opacity', 0.7)
          .attr('class', 'taiji-pulse');
      }
    });
  }

  // Node title (tooltip)
  node.append('title')
    .text(d => `${d.concept}\n인지 수준: ${d.bloomLevel}\n학습 모델 추정치 (검증되지 않음): ${d.mastery === null ? '기록 없음' : `${(d.mastery * 100).toFixed(0)}%`}\n\n${d.description}`);

  // Simulation tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Legend
  const legend = svg.append('g')
    .attr('transform', `translate(${width - 160}, 12)`);

  const legendTitle = legend.append('text')
    .attr('font-size', '12px')
    .attr('font-weight', '600')
    .attr('fill', isDark ? 'var(--surface-0)' : 'var(--ink-primary)')
    .text('학습 모델 추정치 (검증되지 않음)');

  const legendItems = [
    { mastery: 0.9, label: '높음 추정 (≥0.8)' },
    { mastery: 0.6, label: '중간 추정 (0.3~0.8)' },
    { mastery: 0.1, label: '낮음 추정 (<0.3)' },
    { mastery: null, label: '기록 없음' },
  ];

  legendItems.forEach((item, i) => {
    const lg = legend.append('g')
      .attr('transform', `translate(0, ${20 + i * 22})`);

    const radius = calculateNodeRadius(item.mastery);
    lg.append('circle')
      .attr('r', radius + 2)
      .attr('fill', mapMasteryToColor(item.mastery))
      .attr('opacity', 0.8);

    lg.append('text')
      .attr('x', 18)
      .attr('y', 4)
    .attr('fill', isDark ? 'var(--ink-secondary)' : 'var(--ink-tertiary)')
      .attr('font-size', '11px')
      .text(item.label);
  });

  // Stats
  const stats = svg.append('text')
    .attr('x', 12)
    .attr('y', height - 8)
    .attr('fill', 'var(--ink-tertiary)')
    .attr('font-size', '10px')
    .text(`Neural Wiki v35 | 개념: ${nodes.length} | 관계: ${links.length} | 개인 연결: ${graphData.synapses?.length || 0}`);

  return { simulation, svg, d3, nodes, links };
}

// Expose to window for HTML embedding
window.renderNeuralWikiGraph = renderNeuralWikiGraph;
window.calculateNodeRadius = calculateNodeRadius;
window.mapMasteryToColor = mapMasteryToColor;
