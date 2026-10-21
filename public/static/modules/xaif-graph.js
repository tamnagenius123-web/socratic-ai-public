// SocraticAI v27 — xAIF Interactive Graph Visualization
// D3.js force-directed graph for argument mining visualization
// References: Chris Reed (AIF), Stefano Mezza (ArguNet)

const D3_CDN = 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

let d3Module = null;

async function loadD3() {
  if (d3Module) return d3Module;
  try {
    d3Module = await import(D3_CDN);
    return d3Module;
  } catch (e) {
    console.error('[xAIF] D3.js load failed:', e);
    return null;
  }
}

// Node type configurations
const NODE_CONFIG = {
  claim:      { color: '#3B82F6', label: '주장', shape: 'circle', radius: 22 },
  evidence:   { color: '#10B981', label: '근거', shape: 'circle', radius: 18 },
  premise:    { color: '#8B5CF6', label: '전제', shape: 'rect', radius: 16 },
  rebuttal:   { color: '#EF4444', label: '반박', shape: 'diamond', radius: 18 },
  conclusion: { color: '#F59E0B', label: '결론', shape: 'circle', radius: 20 },
  warrant:    { color: '#06B6D4', label: '보증', shape: 'rect', radius: 14 },
};

const EDGE_CONFIG = {
  support:    { color: '#10B981', dashArray: null, label: '지지' },
  attack:     { color: '#EF4444', dashArray: '6,3', label: '반박' },
  premise_of: { color: '#8B5CF6', dashArray: '4,2', label: '전제' },
  rephrase:   { color: '#6B7280', dashArray: '2,2', label: '재진술' },
};

/**
 * Render interactive xAIF force-directed graph
 * @param {string} containerId - DOM container ID
 * @param {object} xaifData - xAIF graph data with nodes/edges
 * @param {object} options - rendering options
 */
export async function renderXAIFGraph(containerId, xaifData, options = {}) {
  const d3 = await loadD3();
  if (!d3) {
    console.warn('[xAIF] D3 not available, falling back to canvas');
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) return;

  // Clear previous content
  container.innerHTML = '';

  const width = options.width || container.clientWidth || 600;
  const height = options.height || Math.max(400, container.clientHeight || 400);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // Prepare data
  const nodes = (xaifData.nodes || []).map((n, i) => ({
    id: n.id || `node_${i}`,
    text: n.text || '',
    type: (n.type || 'claim').replace('aif_', ''),
    turn: n.turn || 1,
    strength: n.strength || 0.5,
  }));

  const nodeIds = new Set(nodes.map(n => n.id));
  const links = (xaifData.edges || []).filter(e => 
    nodeIds.has(e.from || e.source) && nodeIds.has(e.to || e.target)
  ).map((e, i) => ({
    source: e.from || e.source,
    target: e.to || e.target,
    relation: (e.relation || 'support').replace('aif_', ''),
    strength: e.strength || 0.5,
  }));

  if (nodes.length === 0) {
    container.innerHTML = `<div class="flex items-center justify-center h-full text-gray-400 text-sm">
      <i class="fas fa-project-diagram mr-2"></i>논증 그래프 데이터가 없습니다.
    </div>`;
    return;
  }

  // Create SVG
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height])
    .style('font-family', 'Inter, Noto Sans KR, sans-serif');

  // Defs for markers (arrowheads)
  const defs = svg.append('defs');
  
  Object.entries(EDGE_CONFIG).forEach(([type, config]) => {
    defs.append('marker')
      .attr('id', `arrow-${type}`)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 28)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', config.color);
  });

  // Drop shadow filter
  const filter = defs.append('filter').attr('id', 'shadow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%');
  filter.append('feDropShadow').attr('dx', 0).attr('dy', 2).attr('stdDeviation', 3).attr('flood-opacity', 0.15);

  // Force simulation
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(120).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(40));

  // Zoom
  const g = svg.append('g');
  svg.call(d3.zoom()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => g.attr('transform', event.transform)));

  // Links
  const link = g.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', d => (EDGE_CONFIG[d.relation] || EDGE_CONFIG.support).color)
    .attr('stroke-width', d => Math.max(1.5, d.strength * 3))
    .attr('stroke-dasharray', d => (EDGE_CONFIG[d.relation] || EDGE_CONFIG.support).dashArray)
    .attr('marker-end', d => `url(#arrow-${d.relation || 'support'})`);

  // Link labels
  const linkLabel = g.append('g')
    .selectAll('text')
    .data(links)
    .join('text')
    .attr('text-anchor', 'middle')
    .attr('fill', d => (EDGE_CONFIG[d.relation] || EDGE_CONFIG.support).color)
    .attr('font-size', '9px')
    .attr('font-weight', '600')
    .attr('opacity', 0.7)
    .text(d => (EDGE_CONFIG[d.relation] || EDGE_CONFIG.support).label);

  // Node groups
  const node = g.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    );

  // Node shapes
  node.each(function(d) {
    const config = NODE_CONFIG[d.type] || NODE_CONFIG.claim;
    const el = d3.select(this);
    
    el.append('circle')
      .attr('r', config.radius)
      .attr('fill', config.color)
      .attr('stroke', isDark ? '#1E293B' : '#fff')
      .attr('stroke-width', 3)
      .attr('filter', 'url(#shadow)')
      .attr('opacity', 0.9);
  });

  // Node icon labels
  node.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.3em')
    .attr('fill', '#fff')
    .attr('font-size', '9px')
    .attr('font-weight', 'bold')
    .text(d => {
      const config = NODE_CONFIG[d.type] || NODE_CONFIG.claim;
      return config.label;
    });

  // Node text labels below
  node.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', d => (NODE_CONFIG[d.type] || NODE_CONFIG.claim).radius + 14)
    .attr('fill', isDark ? '#CBD5E1' : '#374151')
    .attr('font-size', '10px')
    .attr('font-weight', '500')
    .text(d => d.text.length > 20 ? d.text.substring(0, 20) + '...' : d.text);

  // Turn badge
  node.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', d => -(NODE_CONFIG[d.type] || NODE_CONFIG.claim).radius - 6)
    .attr('fill', isDark ? '#94A3B8' : '#9CA3AF')
    .attr('font-size', '8px')
    .attr('font-weight', '600')
    .text(d => 'T' + d.turn);

  // Tooltip
  node.append('title')
    .text(d => `[${(NODE_CONFIG[d.type] || NODE_CONFIG.claim).label}] Turn ${d.turn}\n${d.text}`);

  // Simulation tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    linkLabel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2 - 5);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Legend
  const legend = svg.append('g')
    .attr('transform', `translate(${width - 130}, 10)`);

  let ly = 0;
  Object.entries(NODE_CONFIG).forEach(([type, config]) => {
    const lg = legend.append('g').attr('transform', `translate(0, ${ly})`);
    lg.append('circle').attr('r', 6).attr('cx', 6).attr('cy', 6).attr('fill', config.color);
    lg.append('text').attr('x', 18).attr('y', 10).attr('fill', isDark ? '#CBD5E1' : '#6B7280')
      .attr('font-size', '10px').text(config.label);
    ly += 18;
  });

  // Stats bar
  const stats = svg.append('text')
    .attr('x', 10)
    .attr('y', height - 8)
    .attr('fill', isDark ? '#94A3B8' : '#9CA3AF')
    .attr('font-size', '10px')
    .text(`xAIF Graph v27 | Nodes: ${nodes.length} | Edges: ${links.length}`);

  return { simulation, svg };
}

/**
 * Create mini xAIF graph for landing page demo
 */
export async function renderDemoGraph(containerId) {
  const demoData = {
    nodes: [
      { id: 'c1', text: 'AI는 교육을 혁신한다', type: 'claim', turn: 1 },
      { id: 'e1', text: '개인화 학습 성과 27% 향상', type: 'evidence', turn: 2 },
      { id: 'e2', text: '적응형 평가 시스템 연구', type: 'evidence', turn: 3 },
      { id: 'r1', text: '디지털 격차 심화 우려', type: 'rebuttal', turn: 4 },
      { id: 'w1', text: '기술 접근성 전제', type: 'warrant', turn: 3 },
      { id: 'co1', text: '조건부 혁신 가능', type: 'conclusion', turn: 5 },
    ],
    edges: [
      { from: 'e1', to: 'c1', relation: 'support', strength: 0.85 },
      { from: 'e2', to: 'c1', relation: 'support', strength: 0.7 },
      { from: 'r1', to: 'c1', relation: 'attack', strength: 0.6 },
      { from: 'w1', to: 'e1', relation: 'premise_of', strength: 0.5 },
      { from: 'c1', to: 'co1', relation: 'support', strength: 0.8 },
    ],
  };

  return renderXAIFGraph(containerId, demoData, { width: 500, height: 350 });
}

// Expose to window
window.renderXAIFGraph = renderXAIFGraph;
window.renderDemoGraph = renderDemoGraph;
