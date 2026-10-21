// Socratic AI v35 — Knowledge Graph Viewer Component
// Mounts neural wiki graph visualization with API integration

import { renderNeuralWikiGraph } from '../neural-wiki-graph.js';
import { apiGet } from '../utils.js';

/**
 * Knowledge Graph Viewer Component
 * Fetches graph data from API and renders neural wiki visualization
 *
 * @param {object} config
 *   - containerId: string (DOM element ID)
 *   - domainId: string (Knowledge domain ID)
 *   - onNodeClick: function (nodeId, nodeData) - callback when node is clicked
 *   - onContextPanelShow: function (nodeData) - callback to show context panel
 *   - apiBaseUrl: string (default '/api')
 *   - width: number (optional)
 *   - height: number (optional)
 *   - taijiActive: boolean (show antipodal pulse)
 *   - taijiAntipodes: array (node IDs for Taiji engine visualization)
 */
export class KnowledgeGraphViewer {
  constructor(config) {
    this.config = {
      apiBaseUrl: '/api',
      ...config,
    };

    this.graphData = null;
    this.isLoading = false;
    this.error = null;
  }

  isCurrent() {
    return this.config.isCurrent?.() !== false;
  }

  /**
   * Initialize and fetch graph data
   */
  async mount() {
    const { containerId, domainId, apiBaseUrl } = this.config;

    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[KnowledgeGraphViewer] Container not found:', containerId);
      return;
    }

    // Show loading state
    this.showLoading(container);

    try {
      this.isLoading = true;

      this.graphData = await apiGet(
        `${apiBaseUrl}/knowledge-graph/domain/${encodeURIComponent(domainId)}/full-graph`,
      );
      this.isLoading = false;
      if (!this.isCurrent()) return;
      this.config.onGraphLoad?.(this.graphData);

      // Render graph
      await this.render();
    } catch (err) {
      this.error = err;
      this.isLoading = false;
      if (!this.isCurrent()) return;
      this.showError(container, err instanceof Error ? err.message : String(err));
      this.config.onGraphError?.(err);
      console.error('[KnowledgeGraphViewer] Error:', err);
    }
  }

  /**
   * Render the graph visualization
   */
  async render() {
    if (!this.isCurrent()) return;
    const {
      containerId,
      onNodeClick,
      onContextPanelShow,
      width,
      height,
      taijiActive,
      taijiAntipodes,
    } = this.config;

    const defaultNodeClickHandler = (nodeId, nodeData) => {
      console.log('[KnowledgeGraphViewer] Node clicked:', nodeId, nodeData);
      if (onContextPanelShow) {
        onContextPanelShow(nodeData);
      }
      if (onNodeClick) {
        onNodeClick(nodeId, nodeData);
      }
    };

    const renderedGraph = await renderNeuralWikiGraph(
      containerId,
      this.graphData,
      {
        width,
        height,
        onNodeClick: defaultNodeClickHandler,
        taijiActive,
        taijiAntipodes,
        isCurrent: () => this.isCurrent(),
      }
    );
    if (!this.isCurrent()) return;
    if (!renderedGraph) throw new Error('Neural Wiki renderer unavailable');
  }

  /**
   * Show loading indicator
   */
  showLoading(container) {
    container.innerHTML = `
      <div class="flex items-center justify-center h-full">
        <div class="text-center">
          <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-current"></div>
          <p class="mt-4 text-sm text-gray-500">그래프 로드 중...</p>
        </div>
      </div>
    `;
  }

  /**
   * Show error message
   */
  showError(container, message) {
    container.innerHTML = `
      <div class="flex items-center justify-center h-full">
        <div class="text-center">
          <i class="fas fa-exclamation-triangle text-red-500 text-2xl mb-4"></i>
          <p class="text-sm text-gray-600">그래프를 로드할 수 없습니다.</p>
          <p class="text-xs text-gray-500 mt-2">${message}</p>
        </div>
      </div>
    `;
  }

  /**
   * Highlight a specific node
   */
  highlightNode(nodeId) {
    this.config.onNodeClick?.(nodeId, this.getNode(nodeId));
  }

  /**
   * Clear highlighting
   */
  clearHighlight() {
    // Selection is represented by the learner context panel, not an undeclared CSS class.
  }

  /**
   * Get graph data (after mount)
   */
  getGraphData() {
    return this.graphData;
  }

  /**
   * Get a specific node by ID
   */
  getNode(nodeId) {
    return this.graphData?.nodes?.find(n => n.id === nodeId) || null;
  }

  /**
   * Get related nodes (direct connections)
   */
  getRelatedNodes(nodeId) {
    if (!this.graphData) return [];

    const relatedNodeIds = new Set();
    this.graphData.edges.forEach(edge => {
      if (edge.fromId === nodeId) {
        relatedNodeIds.add(edge.toId);
      }
      if (edge.toId === nodeId) {
        relatedNodeIds.add(edge.fromId);
      }
    });

    return Array.from(relatedNodeIds)
      .map(id => this.graphData.nodes.find(n => n.id === id))
      .filter(Boolean);
  }
}

// Expose to window
window.KnowledgeGraphViewer = KnowledgeGraphViewer;
