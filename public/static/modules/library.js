// SocraticAI v35 — Library module
(function initializeLibraryModule(S) {
  const { State, getEl, api, apiGet, apiDelete, showToast, esc } = S;
  let ragSearchEnabled = false;

  function createBookCard(book) {
    const card = document.createElement('article');
    card.className = 'card hover:shadow-md transition-shadow';

    const header = document.createElement('div');
    header.className = 'flex items-start gap-3';
    const icon = document.createElement('div');
    icon.className = 'w-12 h-12 bg-primary-50 rounded-xl flex items-center justify-center flex-shrink-0';
    icon.innerHTML = '<i class="fas fa-book text-primary-500" aria-hidden="true"></i>';
    const copy = document.createElement('div');
    copy.className = 'flex-1 min-w-0';
    const title = document.createElement('h4');
    title.className = 'font-bold text-gray-900 truncate';
    title.textContent = String(book.title || '제목 없음');
    const author = document.createElement('p');
    author.className = 'text-xs text-gray-500';
    author.textContent = `${book.author || '-'}${book.chapter ? ` · ${book.chapter}` : ''}`;
    const status = document.createElement('p');
    status.className = 'text-xs text-gray-500 mt-1';
    const chunkCount = Number(book.chunkCount || 0);
    const ingestionLabels = {
      processing: '본문 처리 중',
      d1_ready: '근거 청크 준비됨',
      ready: '의미 검색 준비됨',
      failed: '처리 실패',
      legacy: '상태 확인 필요',
    };
    const scopeLabel = book.scope === 'builtin' ? '기본 도서' : '내 비공개 도서';
    status.textContent = chunkCount > 0
      ? `${scopeLabel} · ${chunkCount}개 근거 청크 · ${ingestionLabels[book.ingestionStatus] || '상태 확인 필요'}`
      : `${scopeLabel} · 근거 청크 없음`;
    copy.append(title, author, status);
    header.append(icon, copy);

    const actions = document.createElement('div');
    actions.className = 'flex gap-2 mt-3';
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'btn-primary text-xs flex-1';
    start.innerHTML = '<i class="fas fa-play mr-1" aria-hidden="true"></i>세션 구성';
    start.addEventListener('click', () => selectBook(String(book.id), start));
    actions.appendChild(start);
    if (chunkCount > 0 && book.vectorStatus !== 'indexed') {
      const indexButton = document.createElement('button');
      indexButton.type = 'button';
      indexButton.className = 'btn-secondary text-xs';
      indexButton.textContent = book.vectorStatus === 'failed' ? '의미 검색 재시도' : '의미 검색 준비';
      indexButton.addEventListener('click', () => indexBook(String(book.id), indexButton));
      actions.appendChild(indexButton);
    }
    if (!book.isBuiltin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary text-xs';
      remove.setAttribute('aria-label', `${book.title || '도서'} 삭제`);
      remove.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
      remove.addEventListener('click', () => deleteBook(String(book.id), String(book.title || '도서')));
      actions.appendChild(remove);
    }
    card.append(header, actions);
    return card;
  }

  async function loadBooks(searchQuery) {
    try {
      const url = searchQuery ? `/api/books?q=${encodeURIComponent(searchQuery)}` : '/api/books';
      const data = await apiGet(url);
      const list = getEl('book-list');
      if (!list) return;
      list.innerHTML = '';
      if (!Array.isArray(data.books) || data.books.length === 0) {
        list.innerHTML = '<div class="text-center py-12 text-gray-400 col-span-2">등록된 도서가 없습니다.</div>';
        return;
      }
      data.books.forEach((book) => list.appendChild(createBookCard(book)));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function debounceSearch() {
    clearTimeout(State.searchTimeout);
    State.searchTimeout = setTimeout(() => {
      const query = getEl('book-search-input')?.value.trim() || '';
      loadBooks(query || undefined);
      if (ragSearchEnabled) performRAGSearch(query);
    }, 300);
  }

  function selectBook(id, trigger) {
    State.selectedBookId = id;
    if (typeof window.openSessionConfigModal === 'function') {
      window.openSessionConfigModal(id, trigger);
    } else {
      showToast('세션 설정을 불러오지 못했습니다.', 'error');
    }
  }

  async function deleteBook(id, title) {
    if (!window.confirm(`"${title}"의 본문과 근거 청크를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      const result = await apiDelete(`/api/books/${encodeURIComponent(id)}`);
      showToast(result.vectorCleanupPending ? '본문은 삭제되었고 검색 인덱스 정리는 대기 중입니다.' : '도서 본문과 근거 청크가 삭제되었습니다.', 'success');
      await loadBooks();
      await loadSparringBookSelector();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function indexBook(id, button) {
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = '의미 검색 준비 중...';
    try {
      const result = await api(`/api/books/${encodeURIComponent(id)}/vectorize`, {});
      showToast(`${Number(result.chunksIndexed || 0)}개 근거 청크의 의미 검색 준비가 완료되었습니다.`, 'success');
      await loadBooks();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }

  function openUploadModal() {
    const modal = getEl('upload-modal');
    if (modal) modal.style.display = 'flex';
    ['upload-title', 'upload-author', 'upload-chapter', 'upload-text'].forEach((id) => {
      const element = getEl(id);
      if (element) element.value = '';
    });
    const count = getEl('upload-text-count');
    if (count) count.textContent = '0자';
  }

  function closeUploadModal() {
    const modal = getEl('upload-modal');
    if (modal) modal.style.display = 'none';
  }

  function handleFileDrop(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('dragover');
    if (event.dataTransfer.files[0]) readUploadFile(event.dataTransfer.files[0]);
  }

  function handleFileSelect(event) {
    if (event.target.files[0]) readUploadFile(event.target.files[0]);
  }

  function setUploadedText(text) {
    const normalizedText = String(text || '').trim();
    const textarea = getEl('upload-text');
    if (textarea) textarea.value = normalizedText;
    const count = getEl('upload-text-count');
    if (count) count.textContent = `${normalizedText.length}자`;
  }

  async function readUploadFile(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    if (extension === 'txt') {
      setUploadedText(await file.text());
    } else if (extension === 'pdf') {
      await parsePDFClientSide(file);
    } else if (extension === 'epub') {
      await parseEPUBClientSide(file);
    } else {
      showToast('지원하지 않는 파일 형식입니다.', 'error');
    }
  }

  function setParseProgress(message, ratio) {
    const progress = getEl('parse-progress');
    if (progress) progress.classList.remove('hidden');
    const text = getEl('parse-progress-text');
    if (text) text.textContent = message;
    const bar = getEl('parse-bar');
    if (bar) bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  async function parsePDFClientSide(file) {
    setParseProgress('PDF 라이브러리 로딩…', 0);
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
      const pdfjsLib = window.pdfjsLib;
      if (!pdfjsLib) throw new Error('PDF.js를 불러오지 못했습니다.');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      const documentHandle = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = '';
      for (let pageIndex = 1; pageIndex <= documentHandle.numPages; pageIndex += 1) {
        setParseProgress(`PDF 파싱 중… (${pageIndex}/${documentHandle.numPages})`, pageIndex / documentHandle.numPages);
        const page = await documentHandle.getPage(pageIndex);
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str).join(' ') + '\n';
      }
      setUploadedText(text);
      showToast(`PDF 파싱 완료 (${documentHandle.numPages}페이지)`, 'success');
    } catch (error) {
      showToast(`PDF 파싱 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      getEl('parse-progress')?.classList.add('hidden');
    }
  }

  async function parseEPUBClientSide(file) {
    setParseProgress('EPUB 라이브러리 로딩…', 0);
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js');
      if (typeof window.ePub !== 'function') throw new Error('EPUB.js를 불러오지 못했습니다.');
      const book = window.ePub(await file.arrayBuffer());
      await book.ready;
      let text = '';
      for (let index = 0; index < book.spine.items.length; index += 1) {
        setParseProgress(`EPUB 파싱 중… (${index + 1}/${book.spine.items.length})`, (index + 1) / book.spine.items.length);
        const section = book.spine.items[index];
        const documentNode = await section.load(book.load.bind(book));
        text += `${documentNode.body?.textContent?.trim() || ''}\n\n`;
      }
      setUploadedText(text);
      showToast('EPUB 파싱 완료', 'success');
    } catch (error) {
      showToast(`EPUB 파싱 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      getEl('parse-progress')?.classList.add('hidden');
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${CSS.escape(src)}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') resolve();
        else existing.addEventListener('load', resolve, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.appendChild(script);
    });
  }

  async function uploadBook() {
    const title = getEl('upload-title')?.value.trim();
    const author = getEl('upload-author')?.value.trim();
    const chapter = getEl('upload-chapter')?.value.trim();
    const text = getEl('upload-text')?.value.trim();
    const language = getEl('upload-language')?.value || 'ko';
    if (!title || !author || !text) return showToast('필수 항목을 입력하세요.', 'error');
    const button = getEl('upload-submit-btn');
    if (button) button.disabled = true;
    try {
      const result = await api('/api/books/upload', { title, author, chapter, text, language });
      showToast(`본문과 근거 청크가 등록되었습니다. (${Number(result.chunkCount || 0)}개)`, 'success');
      closeUploadModal();
      await loadBooks();
      await loadSparringBookSelector();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function toggleRAGSearch() {
    ragSearchEnabled = !ragSearchEnabled;
    const toggle = getEl('rag-search-toggle');
    if (toggle) {
      toggle.style.backgroundColor = ragSearchEnabled ? 'var(--signal-insight)' : '#D1D5DB';
      toggle.setAttribute('aria-pressed', ragSearchEnabled ? 'true' : 'false');
      const thumb = toggle.querySelector('span');
      if (thumb) thumb.style.transform = ragSearchEnabled ? 'translateX(20px)' : 'translateX(0)';
    }
    const section = getEl('rag-results-section');
    if (section) section.style.display = ragSearchEnabled ? 'block' : 'none';
    if (ragSearchEnabled) performRAGSearch(getEl('book-search-input')?.value.trim() || '');
  }

  async function performRAGSearch(query) {
    if (!ragSearchEnabled || !query || query.length < 2) return;
    const section = getEl('rag-results-section');
    if (!section) return;
    try {
      const data = await api('/api/vectorize/query', { query, topK: 5 });
      const matches = Array.isArray(data.matches) ? data.matches : [];
      if (matches.length === 0) {
        section.innerHTML = '<div class="text-center text-sm text-gray-400 py-2">유사한 결과가 없습니다.</div>';
        return;
      }
      section.innerHTML = '<div class="bg-primary-50 border border-primary-200 rounded-xl p-4"><p class="text-xs font-bold text-primary-700 uppercase mb-2"><i class="fas fa-brain mr-1" aria-hidden="true"></i>AI 벡터 유사 검색</p><div class="space-y-2">' + matches.map((match) => {
        const metadata = match.metadata || {};
        const title = metadata.title || metadata.bookTitle || metadata.bookId || match.id || '근거';
        const snippet = metadata.text || metadata.snippet || '';
        return `<div class="bg-white rounded-lg p-2 border border-primary-100 text-sm"><span class="font-bold text-gray-900">${esc(title)}</span><span class="text-xs text-gray-500 ml-2">유사도: ${(Number(match.score || 0) * 100).toFixed(1)}%</span><p class="text-xs text-gray-600 mt-1">${esc(String(snippet).slice(0, 180))}</p></div>`;
      }).join('') + '</div></div>';
    } catch (error) {
      section.innerHTML = `<div class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">${esc(error instanceof Error ? error.message : String(error))}</div>`;
    }
  }

  async function loadSparringBookSelector() {
    try {
      const data = await apiGet('/api/books');
      const selector = getEl('sparring-book-selector');
      if (!selector) return;
      selector.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '도서를 선택하세요';
      selector.appendChild(placeholder);
      (data.books || []).forEach((book) => {
        const option = document.createElement('option');
        option.value = String(book.id);
        option.textContent = `${book.title} — ${book.author || ''}`;
        option.selected = String(book.id) === String(State.selectedBookId || '');
        selector.appendChild(option);
      });
    } catch (error) {
      console.warn('[BOOKS] Selector load failed:', error);
    }
  }

  function onSparringBookSelect(bookId) {
    if (bookId) State.selectedBookId = bookId;
  }

  Object.assign(window, {
    loadBooks,
    debounceSearch,
    selectBook,
    deleteBook,
    openUploadModal,
    closeUploadModal,
    handleFileDrop,
    handleFileSelect,
    uploadBook,
    toggleRAGSearch,
    performRAGSearch,
    loadSparringBookSelector,
    onSparringBookSelect,
  });
  Object.assign(S, { loadBooks, loadSparringBookSelector, selectBook });
})(window.SocraticAI);
