import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';
import JSZip from 'jszip';

@Component({
  selector: 'app-chapters',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chapters.component.html',
  styleUrls: ['./chapters.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChaptersComponent implements OnInit {

  // Config for the CONTENT STATUS column (CL_PDF / QZ / AS / YT)
  readonly contentStatusFields: { key: 'status_cl_pdf' | 'status_qz' | 'status_as' | 'status_yt'; label: string }[] = [
    { key: 'status_cl_pdf', label: 'CL_PDF' },
    { key: 'status_qz', label: 'QZ' },
    { key: 'status_as', label: 'AS' },
    { key: 'status_yt', label: 'YT' },
  ];

  // Detailed View toggle — off by default, hides secondary columns
  detailedView = false;

  toggleDetailedView() {
    this.detailedView = !this.detailedView;
  }

  // ── Static cache: survives navigating away and back, so lookups + the
  // full chapter list load only once per app session instead of refetching
  // every time this screen is opened. Cleared after create/edit/delete.
  private static cache: {
    boards: any[];
    classes: any[];
    subjects: any[];
    books: any[];
    chapters: any[];
  } | null = null;

  static clearCache() {
    ChaptersComponent.cache = null;
  }

  private static saveUiState(inst: ChaptersComponent) {
    ChaptersComponent.uiState = {
      search: inst.search,
      filterBoardId: inst.filterBoardId,
      filterClassId: inst.filterClassId,
      filterSubjectId: inst.filterSubjectId,
      filterBookId: inst.filterBookId,
      filterStatus: inst.filterStatus,
      filterSequence: inst.filterSequence,
      contentStatusFilter: inst.contentStatusFilter,
      filterClassOptions: inst.filterClassOptions,
      filterSubjectOptions: inst.filterSubjectOptions,
      filterBookOptions: inst.filterBookOptions,
      currentPage: inst.currentPage
    };
  }

  // ── Static UI state: remembers filters/search/page across navigating away
  // (e.g. to the Topics screen) and back, so the list looks exactly as the
  // user left it instead of resetting. Cleared only when filters are
  // explicitly cleared via clearFilters().
  private static uiState: {
    search: string;
    filterBoardId: string;
    filterClassId: string;
    filterSubjectId: string;
    filterBookId: string;
    filterStatus: string;
    filterSequence: string;
    contentStatusFilter: string;
    filterClassOptions: any[];
    filterSubjectOptions: any[];
    filterBookOptions: any[];
    currentPage: number;
  } | null = null;

  // ── Lookups ──
  books: any[] = [];
  boards: any[] = [];
  classes: any[] = [];
  subjects: any[] = [];

  // ── List state ──
  chapters: any[] = [];
  filtered: any[] = [];
  loading = false;
  loadingLookups = false;
  search = '';
  filterBoardId = '';
  filterClassId = '';
  filterSubjectId = '';
  filterBookId = '';
  filterStatus = '';
  filterSequence = '';
  contentStatusFilter = ''; // '' = All, '1' = Done, '2' = Not Done, '0' = Clear — matches if ANY of the 4 CONTENT STATUS fields has this value

  // ── Pagination state (client-side, batches of 20) ──
  pageSize = 20;
  currentPage = 1;
  paged: any[] = [];

  // Cascading option lists for the filter bar
  filterClassOptions: any[] = [];
  filterSubjectOptions: any[] = [];
  filterBookOptions: any[] = [];

  // ── Form mode state ──
  formMode: '' | 'add' | 'edit' = '';
  editId: number | null = null;
  saving = false;
  form: any = this.emptyForm();

  deleteConfirm: any = null;

  // ── Book name → codes cascade ──
  booksByName: { [name: string]: any[] } = {};
  uniqueBookNames: string[] = [];
  filteredBookCodes: any[] = [];
  selectedBookName = '';

  // ── Board/Class/Subject cascade (form) ──
  formBoardId: any = '';
  formClassId: any = '';
  formSubjectId: any = '';
  formClassOptions: any[] = [];
  formSubjectOptions: any[] = [];
  formBookOptions: any[] = [];

  // ── Sequence options for filter ──
  sequenceOptions: number[] = [];

  // ── PDF upload / viewer state ──
  readonly PDF_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/ch_pdfs';
  uploadingPdf = false;
  pdfViewerUrl: SafeResourceUrl | null = null;   // set to open the viewer modal
  pdfViewerTitle: string = '';

  // ── Teacher dropdown (sourced from external VidyaMine API, not our DB) ──
  // We only ever save `teacher` (name) + `teacher_image` (full URL) onto the
  // chapter row — there's no upload flow anymore, the photo already lives
  // on VidyaMine's side and we just reference its URL.
  readonly TEACHER_PHOTOS_API = 'https://rest.vidyamine.com/rest/dev/vm_doot/library/teacher-photos/';
  teacherOptions: { id: number; name: string; file_url: string }[] = [];
  loadingTeachers = false;

  // ── Teacher image viewer state ──
  teacherImageViewerUrl: string | null = null;   // set to open the image viewer modal
  teacherImageViewerTitle: string = '';

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    // React to query param CHANGES (not just the initial snapshot). Since this
    // component is reused when navigating between list/add/edit via
    // router.navigate([], { queryParams: ... }), Angular does not re-run
    // ngOnInit — only a full page reload used to pick up the new mode. This
    // subscription makes edit/add open immediately without needing a refresh.
    this.route.queryParamMap.subscribe(params => {
      const mode = params.get('form');
      const id   = params.get('id');
      const newMode: '' | 'add' | 'edit' = (mode === 'add' || mode === 'edit') ? mode : '';
      const newId = id ? Number(id) : null;

      const modeChanged = newMode !== this.formMode || newId !== this.editId;
      this.formMode = newMode;
      this.editId   = newId;

      if (!modeChanged) return;

      if (this.loadingLookups || !this.books.length) {
        // Books not loaded yet — bootstrap() will route to the right view once ready.
        return;
      }

      if (this.formMode === 'edit' && this.editId) {
        this.loadChapterForEdit(this.editId);
      } else if (this.formMode === 'add') {
        this.initAddForm();
      } else if (this.filterBoardId || this.filterClassId || this.filterSubjectId || this.filterBookId || this.filterStatus !== '') {
        this.load();
      } else if (ChaptersComponent.cache) {
        this.chapters = ChaptersComponent.cache.chapters;
        this.buildSequenceOptions();
        this.applyFilter();
      } else {
        this.load();
      }
    });

    this.bootstrap();
  }

  get canWrite() {
    return ['superadmin', 'admin', 'editor'].includes(this.auth.user?.role || '');
  }

  /** Superadmin or admin only — gates visibility of Created By / Updated By audit columns. */
  get canViewAudit() {
    return ['superadmin', 'admin',].includes(this.auth.user?.role || '');
  }

  /** Superadmin or admin only — editor can add/edit but not delete. */
  get canDelete() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  /** Editor role: read-mostly view — sees everything but can only use the Topics button.
   *  Actions column is hidden entirely, and most other controls are view-only for this role. */
  get isEditor(): boolean {
    return this.auth.user?.role === 'editor';
  }

  /** Actions column is hidden completely for editor, even though editor is otherwise canWrite. */
  get showActionsColumn(): boolean {
    return this.canWrite && !this.isEditor;
  }

  /** Swallows a click for controls that must stay view-only for editor
   *  (screenshot download, file-name link, content-status boxes, active toggle, report),
   *  and shows a red "Access denied" toast so it's obvious the click did something. */
  blockIfEditor(event: Event): boolean {
    if (this.isEditor) {
      event.preventDefault();
      event.stopPropagation();
      this.toast.error('Access denied');
      return true;
    }
    return false;
  }

  // ============================================================
  // BOOTSTRAP — load books first, then chapters / form
  // ============================================================

  private bootstrap() {
    // Restore filters/search/page exactly as the user left them (e.g. after
    // navigating to Topics and clicking Back), before deciding how to load.
    if (ChaptersComponent.uiState && !this.isEditor) {
      const s = ChaptersComponent.uiState;
      this.search = s.search;
      this.filterBoardId = s.filterBoardId;
      this.filterClassId = s.filterClassId;
      this.filterSubjectId = s.filterSubjectId;
      this.filterBookId = s.filterBookId;
      this.filterStatus = s.filterStatus;
      this.filterSequence = s.filterSequence;
      this.contentStatusFilter = s.contentStatusFilter || '';
      this.filterClassOptions = s.filterClassOptions;
      this.filterSubjectOptions = s.filterSubjectOptions;
      this.filterBookOptions = s.filterBookOptions;
      this.currentPage = s.currentPage;
    }

    // Serve from cache if we've already loaded once this session.
    if (ChaptersComponent.cache) {
      const c = ChaptersComponent.cache;
      this.boards = c.boards;
      this.classes = c.classes;
      this.subjects = c.subjects;
      this.books = c.books;
      this.buildBooksByName();
      // Only default filterBookOptions to the full book list if it wasn't
      // already restored above from a saved UI state.
      if (!ChaptersComponent.uiState) {
        this.filterBookOptions = [...this.books];
      }
      this.lockFiltersForEditor();
      this.loadingLookups = false;

      if (this.formMode === 'edit' && this.editId) {
        this.loadChapterForEdit(this.editId);
      } else if (this.formMode === 'add') {
        this.initAddForm();
      } else if (this.filterBoardId || this.filterClassId || this.filterSubjectId || this.filterBookId || this.filterStatus !== '') {
        // Filters narrow results via the API (book_id) or via book attributes,
        // so re-run load() to honor whatever filters were set before navigating away.
        this.load(true);
      } else {
        this.chapters = c.chapters;
        this.buildSequenceOptions();
        this.applyFilter(false);
      }
      this.cdr.markForCheck();
      return;
    }

    // ── Lookup fetch, in 3 flat calls instead of 1 + N + M ──
    // /classes and /subjects both return EVERYTHING when called with no
    // query params (confirmed against the backend), so there's no need to
    // loop per-board / per-class making a request each. This alone cuts a
    // 10-20 request waterfall down to a fixed 3 requests.
    this.loadingLookups = true;
    this.api.get<any>('/boards').subscribe({
      next: r => {
        this.boards = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.boards) ? r.boards : []);

        this.api.get<any>('/classes').subscribe({
          next: rc => {
            this.classes = Array.isArray(rc?.data) ? rc.data : (Array.isArray(rc?.classes) ? rc.classes : []);

            this.api.get<any>('/subjects').subscribe({
              next: rs => {
                this.subjects = Array.isArray(rs?.data) ? rs.data : (Array.isArray(rs?.subjects) ? rs.subjects : []);
                this.loadBooks();
              },
              error: () => {
                this.loadingLookups = false;
                this.toast.error('Failed to load subjects');
              }
            });
          },
          error: () => {
            this.loadingLookups = false;
            this.toast.error('Failed to load classes');
          }
        });
      },
      error: () => {
        this.loadingLookups = false;
        this.toast.error('Failed to load boards');
      }
    });
  }

  private loadBooks() {
    this.api.get<any>('/books').subscribe({
      next: r => {
        const raw: any[] = Array.isArray(r?.data) ? r.data : [];
        this.books = raw
          .filter((b: any) => Number(b.is_active) === 1)
          .sort((a: any, b: any) => (Number(a.sequence_number) || 0) - (Number(b.sequence_number) || 0));
        this.buildBooksByName();
        this.filterBookOptions = [...this.books];
        this.lockFiltersForEditor();
        this.loadingLookups = false;

        // Books just became available — route to whatever mode is
        // currently reflected in the URL (covers first load / hard refresh).
        if (this.formMode === 'edit' && this.editId) {
          this.loadChapterForEdit(this.editId);
        } else if (this.formMode === 'add') {
          this.initAddForm();
        } else {
          this.load();
        }

        // Cache lookups now; the chapters array gets filled in by load()
        // above and synced into this same object once it completes.
        ChaptersComponent.cache = {
          boards: this.boards,
          classes: this.classes,
          subjects: this.subjects,
          books: this.books,
          chapters: []
        };
      },
      error: () => {
        this.loadingLookups = false;
        this.toast.error('Failed to load books');
      }
    });
  }

  classesForBoard(boardId: any): any[] {
    if (boardId === '' || boardId === null || boardId === undefined) return [];
    return this.classes.filter(c => String(c.board_id) === String(boardId));
  }

  subjectsForClass(classId: any): any[] {
    if (classId === '' || classId === null || classId === undefined) return [];
    return this.subjects.filter(s => String(s.class_id) === String(classId));
  }

  classOptionLabel(c: any): string {
    return c.name || (c.class_number ? `Class ${c.class_number}` : `Class ${c.id}`);
  }

  /** Books matching the given board/class/subject filters (any of which may be blank). */
  booksFor(boardId: any, classId: any, subjectId: any): any[] {
    return this.books.filter(b =>
      (!boardId || String(b.board_id) === String(boardId)) &&
      (!classId || String(b.class_id) === String(classId)) &&
      (!subjectId || String(b.subject_id) === String(subjectId))
    );
  }

  private buildBooksByName(source?: any[]) {
    const list = source || this.books;
    this.booksByName = {};
    for (const b of list) {
      const name = b.name || '';
      if (!this.booksByName[name]) this.booksByName[name] = [];
      this.booksByName[name].push({ id: b.id, code: b.code, seq: b.sequence_number });
    }
    this.uniqueBookNames = Object.keys(this.booksByName).sort();
  }

  // ============================================================
  // LIST — fetches chapters per book_id (API requires it)
  // ============================================================

  load(preservePage: boolean = false) {
  this.loading = true;

  const url = this.filterBookId
    ? `/chapters?book_id=${this.filterBookId}`
    : `/chapters`;

  this.api.get<any>(url).subscribe({
    next: (r: any) => {
      let list = Array.isArray(r?.data) ? r.data : [];

      // When a specific book isn't chosen, narrow by board/class/subject via the book's own attributes.
      if (!this.filterBookId && (this.filterBoardId || this.filterClassId || this.filterSubjectId)) {
        const allowedBookIds = new Set(
          this.booksFor(this.filterBoardId, this.filterClassId, this.filterSubjectId).map(b => String(b.id))
        );
        list = list.filter((c: any) => allowedBookIds.has(String(c.book_id)));
      }

      list.sort((a: any, b: any) =>
        (Number(a.book_seq_no) - Number(b.book_seq_no)) ||
        (Number(a.sequence) - Number(b.sequence))
      );

      // Pre-compute per-row display values ONCE here instead of calling
      // bookCode()/bookName()/pdfDisplayName()/isActive() from the template.
      // Template method calls re-run on every change-detection tick (every
      // click, hover, unrelated state change) — with 20 rows x 4 lookups
      // each that's 80+ array .find() scans per tick. Storing the result on
      // the row object turns that into a plain property read.
      list = list.map((c: any) => ({
        ...c,
        _bookCode: c.book_code || this.bookCode(c.book_id) || '-',
        _bookName: c.book_name || this.bookName(c.book_id) || '-',
        _pdfDisplay: c.file_name ? this.pdfDisplayName(c.file_name) : null,
        _isActive: Number(c.is_active) === 1
      }));

      if (this.filterStatus !== '') {
        this.chapters = list.filter((c: any) => String(c.is_active) === this.filterStatus);
      } else {
        this.chapters = list;
      }

      // Editors only ever see chapters numbered EDITOR_CHAPTER_MIN..EDITOR_CHAPTER_MAX
      // within their locked CBSE/Class 9/Science/Exploration book. Applied here
      // (not just in the template) so it also governs the stats cards, the
      // SEQUENCE filter dropdown options, and pagination counts.
      if (this.isEditor) {
        this.chapters = this.chapters.filter((c: any) => {
          const n = Number(c.sequence);
          return n >= this.EDITOR_CHAPTER_MIN && n <= this.EDITOR_CHAPTER_MAX;
        });
      }

      this.buildSequenceOptions();
      this.applyFilter(!preservePage);
      this.loading = false;

      // Keep the cache's chapter list in sync when this is the full,
      // unfiltered fetch (board/class/subject/book/status all cleared).
      const noFiltersActive = !this.filterBoardId && !this.filterClassId && !this.filterSubjectId && !this.filterBookId && this.filterStatus === '';
      if (noFiltersActive && ChaptersComponent.cache) {
        ChaptersComponent.cache.chapters = this.chapters;
      }

      // Required under OnPush: this callback runs outside Angular's normal
      // input-binding flow, so explicitly tell Angular this component has
      // new data to render.
      this.cdr.markForCheck();
    },
    error: () => {
      this.chapters = [];
      this.filtered = [];
      this.loading = false;
      this.cdr.markForCheck();
      this.toast.error('Failed to load chapters');
    }
  });
}

  /** Editors are locked to a single Board/Class/Subject/Book combo — CBSE /
   *  Class 9 / Science / Exploration — and, within that book, to chapters
   *  numbered EDITOR_CHAPTER_MIN..EDITOR_CHAPTER_MAX (see the filter in
   *  load() below). Call after `boards` is populated; re-pins all four
   *  cascading filters and their option lists. The matching <select>s are
   *  also [disabled]="isEditor" in the template, and each onFilter*Change()
   *  handler below re-calls this if isEditor, guarding against any
   *  programmatic/devtools change to the (disabled) controls. */
  private readonly EDITOR_CHAPTER_MIN = 4;
  private readonly EDITOR_CHAPTER_MAX = 13;

  private lockFiltersForEditor() {
    if (!this.isEditor || !this.boards.length) return;

    const board = this.boards.find(b =>
      String(b.code || '').toUpperCase() === 'CBSE' ||
      String(b.name || '').toUpperCase().includes('CBSE')
    );
    if (!board) return;
    this.filterBoardId = board.id;
    this.filterClassOptions = this.classesForBoard(this.filterBoardId);

    const klass = this.filterClassOptions.find(c =>
      Number(c.class_number) === 9 || String(c.name || '').toUpperCase().includes('CLASS 9')
    );
    if (!klass) {
      this.filterBookOptions = this.booksFor(this.filterBoardId, '', '');
      return;
    }
    this.filterClassId = klass.id;
    this.filterSubjectOptions = this.subjectsForClass(this.filterClassId);

    const subject = this.filterSubjectOptions.find(s => {
      const name = String(s.name || '').trim().toUpperCase();
      // Exact match on "Science" — must NOT also match "Social Science".
      return name === 'SCIENCE';
    });
    if (!subject) {
      this.filterBookOptions = this.booksFor(this.filterBoardId, this.filterClassId, '');
      return;
    }
    this.filterSubjectId = subject.id;
    this.filterBookOptions = this.booksFor(this.filterBoardId, this.filterClassId, this.filterSubjectId);

    const book = this.filterBookOptions.find(b =>
      String(b.name || '').toUpperCase().includes('EXPLORATION')
    );
    if (book) this.filterBookId = book.id;
  }

  onFilterBoardChange() {
    if (this.isEditor) {
      // Board/class/subject/book are all locked for editors — the <select>s
      // are also disabled in the template, but this guards against any
      // programmatic change.
      this.lockFiltersForEditor();
      return;
    }
    this.filterClassOptions = this.classesForBoard(this.filterBoardId);
    this.filterClassId = '';
    this.filterSubjectOptions = [];
    this.filterSubjectId = '';
    this.filterBookId = '';
    this.filterBookOptions = this.booksFor(this.filterBoardId, '', '');
    this.filterSequence = '';
    this.load();
  }

  onFilterClassChange() {
    if (this.isEditor) {
      this.lockFiltersForEditor();
      return;
    }
    this.filterSubjectOptions = this.subjectsForClass(this.filterClassId);
    this.filterSubjectId = '';
    this.filterBookId = '';
    this.filterBookOptions = this.booksFor(this.filterBoardId, this.filterClassId, '');
    this.filterSequence = '';
    this.load();
  }

  onFilterSubjectChange() {
    if (this.isEditor) {
      this.lockFiltersForEditor();
      return;
    }
    this.filterBookId = '';
    this.filterBookOptions = this.booksFor(this.filterBoardId, this.filterClassId, this.filterSubjectId);
    this.filterSequence = '';
    this.load();
  }

  onFilterChange() {
    if (this.isEditor) {
      this.lockFiltersForEditor();
      return;
    }
    this.filterSequence = '';
    this.load();
  }

  onContentStatusFilterChange() {
    this.applyFilter();
  }

  clearFilters() {
    this.filterBoardId = '';
    this.filterClassId = '';
    this.filterSubjectId = '';
    this.filterBookId = '';
    this.filterStatus = '';
    this.filterSequence = '';
    this.contentStatusFilter = '';
    this.filterClassOptions = [];
    this.filterSubjectOptions = [];
    this.filterBookOptions = [...this.books];
    ChaptersComponent.uiState = null;
    this.lockFiltersForEditor(); // re-pin board/class/subject/book immediately if editor
    this.load();
  }

  applyFilter(resetPage: boolean = true) {
    const q   = this.search.trim().toLowerCase();
    const seq = this.filterSequence;
    const csFilter = this.contentStatusFilter;

    this.filtered = this.chapters.filter((c: any) => {
      const haystack = [
        c.chapter_code, c.name, c.abbreviation, c.file_name,
        c.book_name, c.book_code, c.checked_by,
        c.book_seq_no, c.sequence, c.confidence,
        c.tag, c.description
      ].filter(Boolean).join(' ').toLowerCase();

      const matchesContentStatus = !csFilter || this.contentStatusFields.some(
        f => String(c[f.key] ?? 0) === csFilter
      );

      return (!q || haystack.includes(q)) && (!seq || String(c.sequence) === seq) && matchesContentStatus;
    });

    if (resetPage) this.currentPage = 1;
    // Clamp in case the restored page no longer fits (e.g. data shrank).
    if (this.currentPage > this.totalPages) this.currentPage = this.totalPages;
    this.updatePagedView();
    ChaptersComponent.saveUiState(this);
  }

  // ============================================================
  // PAGINATION (client-side, batches of `pageSize`)
  // ============================================================

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
  }

  /** Shows up to 3 page numbers centered on the current page (e.g. 2,3,4 — not all 21). */
  get pageNumbers(): number[] {
    const total = this.totalPages;
    const windowSize = 3;
    let start = Math.max(1, this.currentPage - 1);
    let end = Math.min(total, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  updatePagedView() {
    const start = (this.currentPage - 1) * this.pageSize;
    this.paged = this.filtered.slice(start, start + this.pageSize);
  }

  /** trackBy for the main chapters table — lets Angular reuse existing row
   *  DOM nodes instead of destroying/recreating all of them whenever
   *  `paged` gets a new array reference (every filter, page change, status
   *  toggle). Without this every row's <tr> and all its children get torn
   *  down and rebuilt on each of those updates. */
  trackByChapterId(index: number, c: any): any {
    return c.id;
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.updatePagedView();
    ChaptersComponent.saveUiState(this);
  }

  nextPage() { this.goToPage(this.currentPage + 1); }
  prevPage() { this.goToPage(this.currentPage - 1); }

  private buildSequenceOptions() {
    const seqSet = new Set<number>();
    for (const c of this.chapters) {
      const s = Number(c.sequence);
      if (s > 0) seqSet.add(s);
    }
    this.sequenceOptions = Array.from(seqSet).sort((a, b) => a - b);
  }

  // ── Stats ──
  get statsTotal()    { return this.chapters.length; }
  get statsActive()   { return this.chapters.filter(c => Number(c.is_active) === 1).length; }
  get statsInactive() { return this.statsTotal - this.statsActive; }
  get statsVerified() { return this.chapters.filter(c => c.confidence === 'Verified').length; }
  get statsBooksInView() {
    return new Set(this.chapters.map((c: any) => c.book_id)).size;
  }

  bookName(bookId: any): string {
    return this.books.find(x => String(x.id) === String(bookId))?.name || '';
  }

  bookCode(bookId: any): string {
    return this.books.find(x => String(x.id) === String(bookId))?.code || '';
  }

  // ============================================================
  // FORM
  // ============================================================

  private emptyForm(): any {
    return {
      book_id: '', sequence: 1, chapter_code: '', icon: '', name: '',
      teacher: '', teacher_image: '',
      abbreviation: '', confidence: 'Unverified',
      file_name: '', book_name: '', tag: '', color: '', description: '', checked_by: '', is_active: 1,
      _bookSeqNo: null as number | null, _bookCode: ''
    };
  }

  initAddForm() {
    this.form = this.emptyForm();
    this.selectedBookName = '';
    this.filteredBookCodes = [];
    this.formBoardId = '';
    this.formClassId = '';
    this.formSubjectId = '';
    this.formClassOptions = [];
    this.formSubjectOptions = [];
    this.formBookOptions = [];
    this.loadTeacherOptions();
  }

  loadChapterForEdit(id: number) {
    this.loadTeacherOptions();
    this.api.get<any>(`/chapters/${id}`).subscribe({
      next: (r: any) => {
        const c = r?.data || null;
        if (!c) { this.toast.error('Chapter not found'); this.goToList(); return; }
        this.form = {
          ...this.emptyForm(), ...c,
          _bookSeqNo: c.book_seq_no ?? null,
          _bookCode:  this.bookCode(c.book_id)
        };

        // Pre-fill the board/class/subject cascade from the chapter's book
        const bookRec = this.books.find(x => String(x.id) === String(c.book_id));
        this.formBoardId = bookRec?.board_id ?? '';
        this.formClassOptions = this.classesForBoard(this.formBoardId);
        this.formClassId = bookRec?.class_id ?? '';
        this.formSubjectOptions = this.subjectsForClass(this.formClassId);
        this.formSubjectId = bookRec?.subject_id ?? '';
        this.formBookOptions = this.booksFor(this.formBoardId, this.formClassId, this.formSubjectId);
        this.buildBooksByName(this.formBookOptions);

        const bName = c.book_name || this.bookName(c.book_id);
        if (bName && this.booksByName[bName]) {
          this.selectedBookName = bName;
          this.onBookNameChange(false);
        }
        this.form.book_id = c.book_id;
        this.updateBookMeta();
        this.cdr.markForCheck();
      },
      error: () => { this.toast.error('Failed to load chapter'); this.goToList(); }
    });
  }

  // ── Board/Class/Subject cascade (form) ──
  onFormBoardChange() {
    this.formClassOptions = this.classesForBoard(this.formBoardId);
    this.formClassId = '';
    this.formSubjectOptions = [];
    this.formSubjectId = '';
    this.formBookOptions = this.booksFor(this.formBoardId, '', '');
    this.buildBooksByName(this.formBookOptions);
    this.resetBookSelection();
  }

  onFormClassChange() {
    this.formSubjectOptions = this.subjectsForClass(this.formClassId);
    this.formSubjectId = '';
    this.formBookOptions = this.booksFor(this.formBoardId, this.formClassId, '');
    this.buildBooksByName(this.formBookOptions);
    this.resetBookSelection();
  }

  onFormSubjectChange() {
    this.formBookOptions = this.booksFor(this.formBoardId, this.formClassId, this.formSubjectId);
    this.buildBooksByName(this.formBookOptions);
    this.resetBookSelection();
  }

  private resetBookSelection() {
    this.selectedBookName = '';
    this.filteredBookCodes = [];
    this.form.book_id = '';
    this.form._bookSeqNo = null;
    this.form._bookCode = '';
  }

  // ── Book cascade ──
  onBookNameChange(resetCode = true) {
    const opts = this.booksByName[this.selectedBookName] || [];
    this.filteredBookCodes = opts;
    if (resetCode) {
      this.form.book_id = opts.length === 1 ? opts[0].id : '';
    }
    this.updateBookMeta();
    if (this.formMode === 'add' && this.form.book_id) this.fetchNextSequence();
  }

  onBookCodeChange() {
    this.updateBookMeta();
    if (this.formMode === 'add' && this.form.book_id) this.fetchNextSequence();
  }

  private updateBookMeta() {
    const b = this.books.find(x => String(x.id) === String(this.form.book_id));
    if (b) {
      this.form._bookSeqNo = Number(b.sequence_number) || null;
      this.form._bookCode  = b.code || '';
      this.form.book_name  = b.name || '';
    } else {
      this.form._bookSeqNo = null;
      this.form._bookCode  = '';
    }
    this.regenerateChapterCode();
    this.regenerateFileName();
  }

  fetchNextSequence() {
    if (this.formMode !== 'add' || !this.form.book_id) return;
    this.api.get<any>(`/chapters?book_id=${this.form.book_id}`).subscribe({
      next: (r: any) => {
        if (r?.status === false || !Array.isArray(r?.data)) return;
        const maxSeq = r.data.reduce((m: number, c: any) => Math.max(m, Number(c.sequence) || 0), 0);
        this.form.sequence = maxSeq + 1;
        this.regenerateChapterCode();
        this.regenerateFileName();
        this.cdr.markForCheck();
      },
      error: () => {}
    });
  }

  // ── Auto-generators ──
  regenerateChapterCode() {
    const seq      = String(this.form.sequence || 1).padStart(2, '0');
    const bookCode = this.form._bookCode || '';
    const parts    = [seq, bookCode].filter(p => p !== '');
    if (parts.length) this.form.chapter_code = parts.join('_');
  }

  regenerateAbbreviation() {
    const raw = (this.form.name || '').replace(/[\(（][^)）]*[\)）]/g, '').trim();
    if (!raw) return;
    const letters = raw.split(/\s+/)
      .map((w: string) => w.replace(/[^a-zA-Z]/g, '').charAt(0))
      .filter(Boolean);
    const abb = letters.join('').toUpperCase();
    if (abb) { this.form.abbreviation = abb; this.regenerateChapterCode(); }
  }

  regenerateFileName() {
    const bookSeq = this.form._bookSeqNo;
    const chapSeq = this.form.sequence;
    if (!bookSeq || !chapSeq) return;
    this.form.file_name =
      String(bookSeq).padStart(2, '0') + '_' + String(chapSeq).padStart(2, '0');
  }

  onSequenceChange() { this.regenerateChapterCode(); this.regenerateFileName(); }
  onNameInput()      { this.regenerateAbbreviation(); }
  onAbbInput() {
    this.form.abbreviation = (this.form.abbreviation || '').toUpperCase();
    this.regenerateChapterCode();
  }

  toggleActive() { this.form.is_active = this.form.is_active ? 0 : 1; }

  /** Current logged-in user's display name, used to auto-stamp "Checked By". */
  get currentUserName(): string {
    return this.auth.user?.name || this.auth.user?.email || '';
  }

  /**
   * Fires when the Confidence dropdown changes.
   * - Marking "Verified" auto-fills Checked By with the logged-in user and locks it.
   * - Reverting to "Unverified" is only allowed if the logged-in user is the same
   *   person who verified it; otherwise the change is blocked and reverted.
   */
  onConfidenceChange(newValue: string) {
    if (newValue === 'Verified') {
      this.form.confidence = 'Verified';
      this.form.checked_by = this.currentUserName;
      return;
    }

    // Trying to set back to Unverified
    if (this.form.checked_by && this.form.checked_by !== this.currentUserName) {
      this.toast.error(`Only ${this.form.checked_by} can mark this as Unverified`);
      this.form.confidence = 'Verified'; // revert the dropdown
      return;
    }

    this.form.confidence = 'Unverified';
    this.form.checked_by = '';
  }

  // ============================================================
  // PDF UPLOAD / VIEWER
  // ============================================================

  /** Builds the public URL for a stored file_name (base name, no extension). */
  pdfUrl(fileName: string | null | undefined): string {
    if (!fileName) return '';
    const base = fileName.replace(/\.pdf$/i, '');
    return `${this.PDF_BASE}/${base}.pdf`;
  }

  /** Display label with the .PDF extension shown, even though it's stored without one. */
  pdfDisplayName(fileName: string | null | undefined): string {
    if (!fileName) return '';
    const base = fileName.replace(/\.pdf$/i, '');
    return `${base}.PDF`;
  }

  /** Triggers the hidden file input for PDF upload (used in the edit/add form). */
  triggerPdfPicker(input: HTMLInputElement) {
    input.value = '';
    input.click();
  }

  onPdfFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      this.toast.error('Please select a PDF file');
      return;
    }

    // Chapter must exist (edit mode) to attach the PDF straight away.
    if (this.formMode !== 'edit' || !this.editId) {
      this.toast.error('Please save the chapter first, then upload its PDF');
      return;
    }

    const formData = new FormData();
    formData.append('chapter_id', String(this.editId));
    formData.append('file_name', this.form.file_name || this.form.chapter_code || '');
    formData.append('file', file, file.name);

    this.uploadingPdf = true;
    this.api.post<any>('/chapters/upload-pdf', formData).subscribe({
      next: (r: any) => {
        this.uploadingPdf = false;
        if (r?.status) {
          this.form.file_name = r.file_name;
          this.toast.success('PDF uploaded');
        } else {
          this.toast.error(r?.message || 'PDF upload failed');
        }
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        this.uploadingPdf = false;
        this.toast.error(err?.error?.message || 'PDF upload failed');
        this.cdr.markForCheck();
      }
    });
  }

  /** Opens the PDF viewer popup for a given base file_name (no extension). */
  openPdfViewer(fileName: string | null | undefined, title?: string) {
    if (!fileName) { this.toast.error('No PDF uploaded for this chapter'); return; }
    this.pdfViewerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.pdfUrl(fileName));
    this.pdfViewerTitle = title || this.pdfDisplayName(fileName);
  }

  closePdfViewer() {
    this.pdfViewerUrl = null;
    this.pdfViewerTitle = '';
  }

  // ============================================================
  // TEACHER DROPDOWN (from external VidyaMine API) + VIEWER
  // ============================================================

  /** Fetches the teacher list (name + photo URL) from VidyaMine's API. */
  loadTeacherOptions() {
    if (this.teacherOptions.length || this.loadingTeachers) return; // fetch once per session
    this.loadingTeachers = true;
    fetch(this.TEACHER_PHOTOS_API, {
      method: 'GET',
      headers: { 'VidyaMine': 'vidyamine', 'Production': 'doot' }
    })
      .then(res => res.json())
      .then((r: any) => {
        const list = Array.isArray(r?.data) ? r.data : [];
        this.teacherOptions = list.map((t: any) => ({
          id: t.id,
          name: t.name,
          file_url: t.file_url
        }));
        this.loadingTeachers = false;
        this.cdr.markForCheck();
      })
      .catch(() => {
        this.loadingTeachers = false;
        this.toast.error('Failed to load teacher list');
        this.cdr.markForCheck();
      });
  }

  /** Fires when a teacher is picked from the dropdown — stores name + full photo URL directly on the form. */
  onTeacherSelect() {
    const picked = this.teacherOptions.find(t => t.name === this.form.teacher);
    this.form.teacher_image = picked?.file_url || '';
  }

  /** Opens the teacher image viewer popup. teacher_image is already a full URL now. */
  openTeacherImageViewer(teacherImage: string | null | undefined, title?: string) {
    if (!teacherImage) { this.toast.error('No teacher image available for this chapter'); return; }
    this.teacherImageViewerUrl = teacherImage;
    this.teacherImageViewerTitle = title || 'Teacher Photo';
  }

  closeTeacherImageViewer() {
    this.teacherImageViewerUrl = null;
    this.teacherImageViewerTitle = '';
  }

  save() {
    if (!this.form.book_id || !this.form.chapter_code?.trim() || !this.form.name?.trim()) {
      this.toast.error('Book, Chapter Code and Name are required');
      return;
    }
    this.saving = true;
    const payload: any = {
      book_id:      Number(this.form.book_id),
      sequence:     Number(this.form.sequence || 1),
      chapter_code: this.form.chapter_code.trim(),
      icon:         this.form.icon?.trim() || null,
      name:         this.form.name.trim(),
      teacher:      this.form.teacher?.trim() || null,
      teacher_image: this.form.teacher_image || null,
      abbreviation: this.form.abbreviation?.trim() || null,
      confidence:   this.form.confidence || 'Unverified',
      file_name:    this.form.file_name?.trim() || null,
      book_name:    this.form.book_name || null,
      tag:          this.form.tag?.trim() || null,
      color:        this.form.color?.trim() || null,
      description:  this.form.description?.trim() || null,
      checked_by:   this.form.confidence === 'Verified' ? (this.form.checked_by?.trim() || this.currentUserName) : null,
      is_active:    Number(this.form.is_active)
    };

    const req = this.formMode === 'add'
      ? this.api.post<any>('/chapters', payload)
      : this.api.put<any>(`/chapters/${this.editId}`, payload);

    req.subscribe({
      next: (r: any) => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.formMode === 'add' ? 'Chapter created' : 'Chapter updated');
          ChaptersComponent.clearCache();
          this.goToList();
        } else {
          this.toast.error(r?.message || 'Operation failed');
        }
        this.cdr.markForCheck();
      },
      error: () => { this.saving = false; this.toast.error('Request failed'); this.cdr.markForCheck(); }
    });
  }

  // ============================================================
  // DELETE / TOGGLE
  // ============================================================

  confirmDelete(c: any) {
    if (!this.canDelete) {
      this.toast.error('Access denied');
      return;
    }
    this.deleteConfirm = c;
  }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/chapters/${this.deleteConfirm.id}`).subscribe({
      next: (r: any) => {
        if (r?.status) { this.toast.success('Chapter deleted'); ChaptersComponent.clearCache(); this.load(); }
        else { this.toast.error(r?.message || 'Delete failed'); }
        this.deleteConfirm = null;
        this.cdr.markForCheck();
      },
      error: () => { this.toast.error('Delete failed'); this.deleteConfirm = null; this.cdr.markForCheck(); }
    });
  }

  toggleStatus(c: any) {
    const newVal = Number(c.is_active) === 1 ? 0 : 1;
    this.api.put<any>(`/chapters/${c.id}`, { is_active: newVal }).subscribe({
      next: (r: any) => {
        if (r?.status) {
          c.is_active = newVal;
          c._isActive = newVal === 1;   // keep the pre-computed row field in sync
          this.toast.success('Status updated');
          this.applyFilter();
          if (ChaptersComponent.cache) {
            const cached = ChaptersComponent.cache.chapters.find((x: any) => String(x.id) === String(c.id));
            if (cached) { cached.is_active = newVal; cached._isActive = newVal === 1; }
          }
        }
        else { this.toast.error(r?.message || 'Failed to update status'); }
        this.cdr.markForCheck();
      },
      error: () => { this.toast.error('Failed to update status'); this.cdr.markForCheck(); }
    });
  }

  // ============================================================
  // CONTENT STATUS (CL_PDF / QZ / AS / YT) — tri-state cycle
  // 0 = empty, 1 = done (green tick), 2 = not done (red cross)
  // ============================================================

  csStatusTitle(val: any): string {
    const n = Number(val);
    if (n === 1) return 'Done — click to change';
    if (n === 2) return 'Not done — click to change';
    return 'Not set — click to choose';
  }

  // id of the row+field whose dropdown is currently open, e.g. "42_status_qz"
  openContentStatusKey: string | null = null;

  contentStatusDropdownKey(c: any, field: string): string {
    return `${c.id}_${field}`;
  }

  isContentStatusDropdownOpen(c: any, field: string): boolean {
    return this.openContentStatusKey === this.contentStatusDropdownKey(c, field);
  }

  toggleContentStatusDropdown(c: any, field: string, event?: MouseEvent) {
    if (event) { event.stopPropagation(); }
    const key = this.contentStatusDropdownKey(c, field);
    this.openContentStatusKey = this.openContentStatusKey === key ? null : key;
    this.cdr.markForCheck();
  }

  closeContentStatusDropdown() {
    if (this.openContentStatusKey !== null) {
      this.openContentStatusKey = null;
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:click')
  onDocumentClickCloseCsDropdown() {
    this.closeContentStatusDropdown();
  }

  setContentStatus(c: any, field: 'status_cl_pdf' | 'status_qz' | 'status_as' | 'status_yt', value: number, event?: MouseEvent) {
    if (event) { event.stopPropagation(); }
    this.openContentStatusKey = null;

    const prev = c[field];
    if (Number(prev) === value) { this.cdr.markForCheck(); return; }

    c[field] = value; // optimistic UI update
    this.cdr.markForCheck();

    this.api.put<any>(`/chapters/${c.id}/content-status`, { field, value }).subscribe({
      next: (r: any) => {
        if (!r?.status) {
          c[field] = prev; // revert on failure
          this.toast.error(r?.message || 'Failed to update content status');
          this.cdr.markForCheck();
          return;
        }
        if (ChaptersComponent.cache) {
          const cached = ChaptersComponent.cache.chapters.find((x: any) => String(x.id) === String(c.id));
          if (cached) { cached[field] = value; }
        }
      },
      error: () => {
        c[field] = prev; // revert on failure
        this.toast.error('Failed to update content status');
        this.cdr.markForCheck();
      }
    });
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  goToAdd()  { this.router.navigate(['/chapters'], { queryParams: { form: 'add' } }); }
  goToEdit(c: any) { this.router.navigate(['/chapters'], { queryParams: { form: 'edit', id: c.id } }); }
  goToList() { this.router.navigate(['/chapters'], { queryParams: {} }); }
  goToTopics(c: any) { this.router.navigate(['/topics'], { queryParams: { chapter_id: c.id } }); }

  isActive(c: any): boolean { return Number(c.is_active) === 1; }

  // Opens the dedicated full-page Chapter Report screen (separate route,
  // not a modal) for the given chapter.
  goToReport(c: any) { this.router.navigate(['/reports/chapters', c.id]); }

  // ============================================================
  // EXPORT ALL SCREENSHOTS OF A CHAPTER AS A ZIP (flat, all topics combined)
  // ============================================================
  //
  // Same approach as the Topics screen's export: fetches every topic for
  // this chapter, pulls each topic's screenshots as blobs from
  // SCREENSHOT_BASE, and packs them all directly into a single
  // "<chapter_code>" folder inside the zip (no per-topic subfolder).

  readonly SCREENSHOT_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/Screenshots';

  // Tracks which chapter row is currently exporting, so the icon can show
  // a spinner/disabled state per-row without a global flag.
  exportingChapterId: number | null = null;

  screenshotUrl(filename: string): string {
    return `${this.SCREENSHOT_BASE}/${filename}`;
  }

  private sanitizeForFsName(name: string): string {
    return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
  }

  private fetchAsBlob(url: string): Promise<Blob> {
    return fetch(url).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.blob();
    });
  }

  private triggerBlobDownload(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  async exportChapterScreenshotsZip(c: any) {
    if (this.exportingChapterId !== null) return;

    this.exportingChapterId = c.id;
    this.cdr.markForCheck();

    try {
      const topics: any[] = await new Promise((resolve, reject) => {
        this.api.get<any>(`/topics?chapter_id=${c.id}`).subscribe({
          next: (res: any) => resolve(res?.data || res?.topics || res || []),
          error: (err: any) => reject(err)
        });
      });

      const topicsWithShots = (topics || []).filter(t => t._screenshots
        ? t._screenshots.length
        : (t.screenshots && JSON.parse(t.screenshots || '[]').length));

      // Normalize: some API shapes give raw JSON string 'screenshots' instead
      // of pre-parsed '_screenshots' (topics.component hydrates this itself;
      // here we do it inline since we don't have that hydration step).
      const normalized = topicsWithShots.map(t => ({
        ...t,
        _screenshots: t._screenshots || JSON.parse(t.screenshots || '[]')
      }));

      if (!normalized.length) {
        this.toast.error('No screenshots to export for this chapter');
        return;
      }

      const zip = new JSZip();
      const chapterFolderName = this.sanitizeForFsName(c.chapter_code || c.name || `chapter_${c.id}`);
      const root = zip.folder(chapterFolderName)!;

      for (const t of normalized) {
        for (const filename of t._screenshots as string[]) {
          try {
            const blob = await this.fetchAsBlob(this.screenshotUrl(filename));
            root.file(filename, blob);
          } catch (e) {
            console.error('Failed to fetch screenshot for zip:', filename, e);
          }
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadName = `${chapterFolderName}_screenshots.zip`;
      this.triggerBlobDownload(zipBlob, downloadName);
      this.toast.success('Screenshots exported');
    } catch (e) {
      console.error('Chapter zip export failed:', e);
      this.toast.error('Failed to export screenshots');
    } finally {
      this.exportingChapterId = null;
      this.cdr.markForCheck();
    }
  }

  // ============================================================
  // BULK EXPORT: "Original PDF + comments.md" ZIP for a WHOLE CHAPTER
  // ============================================================
  //
  // Loops every topic in the chapter, and for each one that has comments on
  // its Claude PDF (Original slot only, for now), builds:
  //   - the topic's WHOLE original Claude PDF, untouched (no page filtering
  //     or client-side rebuilding — fetched and shipped as-is)
  //   - a matching comments.md, with headings keyed to the ORIGINAL PDF's
  //     page numbers (no remapping needed since the full PDF is included)
  // and packs each topic's pair, plus its screenshots, into its own
  // "<topic_code>/" folder inside one chapter-level zip, named:
  //   <topic_code>_Claude_PDF_original.pdf
  //   <topic_code>_Claude_PDF_comments.md
  // Topics with no Claude PDF comments are skipped silently. Runs entirely
  // in the background — only a per-row spinner + a final toast, no
  // navigation away from this screen.

  readonly API_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm';

  // Tracks which chapter row is currently running a bulk commented-zip
  // export, so the button can show a spinner/disabled state per-row
  // without a global flag (separate from exportingChapterId, which is
  // for the plain screenshots export above).
  exportingCommentedChapterId: number | null = null;

  /** Same clean-md format as Compare View's buildCommentsMarkdownClean(), grouped by the ORIGINAL PDF page number
   *  (no remapping — the exported PDF is now the full original file, so its page numbers already match). */
  private buildCommentsMarkdownCleanForChapter(
    commentsByPage: Map<number, any[]> // key = original pdf page number (1-based)
  ): Blob {
    const lines: string[] = [];
    lines.push(
      'This file contains page-wise comments and correction instructions for the PDF slides. ' +
      'It serves as a review document, highlighting the changes that need to be made on each slide ' +
      'to improve the content, mathematical notation, alignment, formatting, and overall presentation quality. ' +
      'Each comment corresponds to a specific page of the PDF and clearly describes the required correction ' +
      'so that the slides can be updated accurately before finalization.'
    );
    lines.push('');
    lines.push(
      '*Headings below refer to the page number inside the accompanying original PDF.*'
    );
    lines.push('');

    const sortedPages = Array.from(commentsByPage.keys()).sort((a, b) => a - b);
    for (const pageNum of sortedPages) {
      lines.push(`## Page ${pageNum}`);
      lines.push('');
      for (const c of commentsByPage.get(pageNum)!) {
        lines.push(String(c.text || '').replace(/\n/g, '  \n'));
        lines.push('');
      }
    }

    return new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  }

  /**
   * For one topic: fetches its Claude PDF comments (Original slot,
   * doc_type='claude_pdf') via the authenticated ApiService (raw fetch()
   * has no auth headers/cookies and will 401/404 against this API), and if
   * any exist, downloads the WHOLE original Claude PDF as-is (no page
   * filtering/rebuilding) and returns it alongside the comments markdown.
   * Returns null if the topic has no Claude PDF or no comments on it.
   */
  private async buildTopicCommentedPair(topic: any): Promise<{ pdfBlob: Blob; mdBlob: Blob } | null> {
    if (!topic?.slide_claude_pdf) return null; // no Claude PDF (Original) attached

    const comments: any[] = await new Promise((resolve, reject) => {
      this.api.get<any>(`/topics/${topic.id}/comparison-comments?doc_type=claude_pdf`).subscribe({
        next: (res: any) => resolve(res?.data || []),
        error: (err: any) => reject(err)
      });
    });
    if (!comments.length) return null;

    // page_key for PDF panes is "page-N" (1-based) — see Compare View's loadPdfPane().
    const commentsByPage = new Map<number, any[]>();
    for (const c of comments) {
      const m = /^page-(\d+)$/.exec(c.page_key || '');
      if (!m) continue;
      const pageNum = Number(m[1]);
      if (!commentsByPage.has(pageNum)) commentsByPage.set(pageNum, []);
      commentsByPage.get(pageNum)!.push(c);
    }
    if (!commentsByPage.size) return null;

    // Ship the full original PDF untouched — no pdf.js rendering / page rebuilding.
    const pdfBlob = await this.fetchAsBlob(
      `${this.API_BASE}/topics/${topic.id}/slide-doc/claude_pdf`
    );
    const mdBlob = this.buildCommentsMarkdownCleanForChapter(commentsByPage);

    return { pdfBlob, mdBlob };
  }

  /** Entry point for the per-chapter-row bulk export button. */
  async exportChapterCommentedZip(c: any) {
    if (this.exportingCommentedChapterId !== null) return;

    this.exportingCommentedChapterId = c.id;
    this.cdr.markForCheck();

    try {
      const topics: any[] = await new Promise((resolve, reject) => {
        this.api.get<any>(`/topics?chapter_id=${c.id}`).subscribe({
          next: (res: any) => resolve(res?.data || res?.topics || res || []),
          error: (err: any) => reject(err)
        });
      });

      if (!topics.length) {
        this.toast.error('No topics found in this chapter');
        return;
      }

      const zip = new JSZip();
      const chapterFolderName = this.sanitizeForFsName(c.chapter_code || c.name || `chapter_${c.id}`);
      const root = zip.folder(chapterFolderName)!;

      let includedCount = 0;
      for (const t of topics) {
        try {
          const pair = await this.buildTopicCommentedPair(t);
          if (!pair) continue; // no Claude PDF / no comments — skip silently
          const topicFolderName = this.sanitizeForFsName(t.topic_code || t.name || `topic_${t.id}`);
          const topicFolder = root.folder(topicFolderName)!;
          topicFolder.file(`${topicFolderName}_Claude_PDF_original.pdf`, pair.pdfBlob);
          topicFolder.file(`${topicFolderName}_Claude_PDF_comments.md`, pair.mdBlob);

          // Also drop in the topic's own screenshot(s), same source as the
          // plain screenshots export above — 'screenshots' may arrive as a
          // raw JSON string (unhydrated here), '_screenshots' if pre-parsed.
          const topicScreenshots: string[] = t._screenshots || JSON.parse(t.screenshots || '[]');
          for (const filename of topicScreenshots) {
            try {
              const shotBlob = await this.fetchAsBlob(this.screenshotUrl(filename));
              topicFolder.file(filename, shotBlob);
            } catch (e) {
              console.error('Failed to fetch topic screenshot for zip:', filename, e);
            }
          }

          includedCount++;
        } catch (e) {
          console.error('Failed to export commented pair for topic:', t?.id, e);
        }
      }

      if (!includedCount) {
        this.toast.error('No commented Claude PDFs found in this chapter');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadName = `${chapterFolderName}_commented_slides.zip`;
      this.triggerBlobDownload(zipBlob, downloadName);
      this.toast.success(`Exported ${includedCount} topic${includedCount === 1 ? '' : 's'} with comments`);
    } catch (e) {
      console.error('Chapter commented-zip export failed:', e);
      this.toast.error('Failed to export commented slides');
    } finally {
      this.exportingCommentedChapterId = null;
      this.cdr.markForCheck();
    }
  }
}