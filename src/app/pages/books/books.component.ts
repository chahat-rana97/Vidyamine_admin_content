import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-books',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './books.component.html',
  styleUrls: ['./books.component.css']
})
export class BooksComponent implements OnInit {
  // ── Static cache: survives navigating away and back, so data loads
  // only once per app session instead of refetching every time this
  // screen is opened. Reset via BooksComponent.clearCache() if ever needed
  // (e.g. after an add/edit/delete elsewhere, or a manual "refresh").
  private static cache: {
    boards: any[];
    classes: any[];
    subjects: any[];
    publishers: any[];
    masterBooks: any[];
    languages: any[];
    courseTypes: any[];
    books: any[];
    maxSequence: number;
  } | null = null;

  static clearCache() {
    BooksComponent.cache = null;
  }

  // ── Lookups ──
  boards: any[] = [];
  classes: any[] = [];
  subjects: any[] = [];
  publishers: any[] = [];
  masterBooks: any[] = [];
  languages: any[] = [];
  courseTypes: any[] = [];

  // ── List state ──
  books: any[] = [];
  filtered: any[] = [];
  loading = false;
  loadingLookups = false;
  search = '';
  filterBoardId = '';
  filterClassId = '';
  filterSubjectId = '';
  filterStatus = '';

  // ── Pagination state (client-side, batches of 10) ──
  pageSize = 20;
  currentPage = 1;
  paged: any[] = [];

  // Class/subject options scoped to the filter bar's selected board/class
  filterClassOptions: any[] = [];
  filterSubjectOptions: any[] = [];

  // ── Form mode state ──
  formMode: '' | 'add' | 'edit' = '';
  editId: number | null = null;
  saving = false;
  form: any = this.emptyForm();

  // Class/subject options scoped to the form's selected board/class
  formClassOptions: any[] = [];
  formSubjectOptions: any[] = [];

  deleteConfirm: any = null;
  maxSequence = 0;

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit() {
    this.route.queryParamMap.subscribe(params => {
      const mode = params.get('form');
      const id = params.get('id');
      this.formMode = mode === 'add' || mode === 'edit' ? mode : '';
      this.editId = id ? Number(id) : null;
      this.bootstrap();
    });
  }

  get canWrite() {
    return ['superadmin', 'admin', 'editor'].includes(this.auth.user?.role || '');
  }

  get canDelete() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  // ============================================================
  // BOOTSTRAP
  // ============================================================

  private bootstrap() {
    // Serve from cache if we've already loaded once this session.
    if (BooksComponent.cache) {
      const c = BooksComponent.cache;
      this.boards = c.boards;
      this.classes = c.classes;
      this.subjects = c.subjects;
      this.publishers = c.publishers;
      this.masterBooks = c.masterBooks;
      this.languages = c.languages;
      this.courseTypes = c.courseTypes;
      this.books = c.books;
      this.maxSequence = c.maxSequence;
      this.loadingLookups = false;

      if (this.formMode === 'edit' && this.editId) {
        this.loadBookForEdit(this.editId);
      } else if (this.formMode === 'add') {
        this.initAddForm();
      } else if (this.filterBoardId || this.filterClassId || this.filterSubjectId || this.filterStatus !== '') {
        // Dropdown filters are applied server-side, so re-run load() to
        // honor whatever filters were set before navigating away.
        this.load();
      } else {
        this.applyFilter();
      }
      return;
    }

    this.loadingLookups = true;
    this.api.get<any>('/boards').subscribe({
      next: r => {
        this.boards = this.readList(r);
        this.loadAllClasses(() => {
          this.loadAllSubjects(() => {
            this.loadPublishers(() => {
              this.loadLanguages(() => {
                this.loadCourseTypes(() => {
                  this.loadAllBooksForLookup(() => {
                    this.loadingLookups = false;

                    // Cache everything now that the full bootstrap is done.
                    BooksComponent.cache = {
                      boards: this.boards,
                      classes: this.classes,
                      subjects: this.subjects,
                      publishers: this.publishers,
                      masterBooks: this.masterBooks,
                      languages: this.languages,
                      courseTypes: this.courseTypes,
                      books: this.books,
                      maxSequence: this.maxSequence
                    };

                    if (this.formMode === 'edit' && this.editId) {
                      this.loadBookForEdit(this.editId);
                    } else if (this.formMode === 'add') {
                      this.initAddForm();
                    } else {
                      this.load();
                    }
                  });
                });
              });
            });
          });
        });
      },
      error: () => {
        this.loadingLookups = false;
        this.toast.error('Failed to load boards');
      }
    });
  }

  private loadAllClasses(done: () => void) {
    // Fetch classes for every board so the filter bar + form cascades work without re-fetching per board
    const calls = this.boards.map(b =>
      new Promise<void>(resolve => {
        this.api.get<any>(`/classes?board_id=${b.id}`).subscribe({
          next: r => {
            const list = this.readList(r);
            this.classes.push(...list);
            resolve();
          },
          error: () => resolve()
        });
      })
    );
    Promise.all(calls).then(() => {
      // De-duplicate by id in case any endpoint call returned overlapping records
      // (e.g. if the API ever ignores board_id and returns the full class list).
      const seen = new Map<string, any>();
      for (const c of this.classes) {
        seen.set(String(c.id), c);
      }
      this.classes = Array.from(seen.values());
      done();
    });
  }

  private loadAllSubjects(done: () => void) {
    const calls = this.classes.map(c =>
      new Promise<void>(resolve => {
        this.api.get<any>(`/subjects?class_id=${c.id}`).subscribe({
          next: r => {
            const list = this.readList(r);
            this.subjects.push(...list);
            resolve();
          },
          error: () => resolve()
        });
      })
    );
    Promise.all(calls).then(() => {
      // De-duplicate by id in case any endpoint call returned overlapping records
      // (e.g. if the API ever ignores class_id and returns the full subject list).
      const seen = new Map<string, any>();
      for (const s of this.subjects) {
        seen.set(String(s.id), s);
      }
      this.subjects = Array.from(seen.values());
      done();
    });
  }

  private loadPublishers(done: () => void) {
    const calls = this.boards.map(b =>
      new Promise<void>(resolve => {
        this.api.get<any>(`/publishers?board_id=${b.id}`).subscribe({
          next: r => {
            const list = this.readList(r);
            this.publishers.push(...list);
            resolve();
          },
          error: () => resolve()
        });
      })
    );
    Promise.all(calls).then(done);
  }

  private loadLanguages(done: () => void) {
    this.api.get<any>('/languages').subscribe({
      next: r => { this.languages = this.readList(r); done(); },
      error: () => done()
    });
  }

  private loadCourseTypes(done: () => void) {
    this.api.get<any>('/course-types').subscribe({
      next: r => { this.courseTypes = this.readList(r); done(); },
      error: () => done()
    });
  }

  private loadAllBooksForLookup(done: () => void) {
    // used to populate Master Book dropdown + compute max sequence number
    this.api.get<any>('/books').subscribe({
      next: r => {
        const list = this.readList(r);
        this.masterBooks = list.filter((b: any) => b.type === 'Master Book');
        this.maxSequence = list.reduce((n: number, b: any) => Math.max(n, Number(b.sequence_number || 0)), 0);
        done();
      },
      error: () => done()
    });
  }

  // ============================================================
  // LIST
  // ============================================================

  load() {
    this.loading = true;
    const params: string[] = [];
    if (this.filterBoardId) params.push(`board_id=${this.filterBoardId}`);
    if (this.filterClassId) params.push(`class_id=${this.filterClassId}`);
    if (this.filterSubjectId) params.push(`subject_id=${this.filterSubjectId}`);
    const qs = params.length ? `?${params.join('&')}` : '';

    this.api.get<any>(`/books${qs}`).subscribe({
      next: r => {
        if (r?.status) {
          let list = this.readList(r);
          if (this.filterStatus !== '') {
            const want = Number(this.filterStatus);
            list = list.filter((b: any) => Number(b.is_active) === want);
          }
          this.books = list;
          this.applyFilter();

          // Keep the cache's book list in sync when this is the full,
          // unfiltered fetch (board/class/subject/status all cleared).
          if (!this.filterBoardId && !this.filterClassId && !this.filterSubjectId && this.filterStatus === '' && BooksComponent.cache) {
            BooksComponent.cache.books = list;
          }
        } else {
          this.toast.error(r?.message || 'Failed to load books');
        }
        this.loading = false;
      },
      error: () => {
        this.toast.error('Failed to load books');
        this.loading = false;
      }
    });
  }

  onFilterChange() {
    this.load();
  }

  onFilterBoardChange() {
    this.filterClassOptions = this.classesForBoard(this.filterBoardId);
    this.filterClassId = '';
    this.filterSubjectOptions = [];
    this.filterSubjectId = '';
    this.load();
  }

  onFilterClassChange() {
    this.filterSubjectOptions = this.subjectsForClass(this.filterClassId);
    this.filterSubjectId = '';
    this.load();
  }

  clearFilters() {
    this.filterBoardId = '';
    this.filterClassId = '';
    this.filterSubjectId = '';
    this.filterStatus = '';
    this.filterClassOptions = [];
    this.filterSubjectOptions = [];
    this.load();
  }

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.books.filter(b =>
          (b.name || '').toLowerCase().includes(q) ||
          (b.code || '').toLowerCase().includes(q) ||
          this.subjectName(b).toLowerCase().includes(q) ||
          this.publisherLabel(b).toLowerCase().includes(q)
        )
      : [...this.books];

    // Search/filter run against the full `books` array above, so results
    // are correct across the whole dataset. Only the on-screen table is
    // paginated, in batches of `pageSize`.
    this.currentPage = 1;
    this.updatePagedView();
  }

  // ============================================================
  // PAGINATION (client-side, batches of `pageSize`)
  // ============================================================

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filtered.length / this.pageSize));
  }

  get pageNumbers(): number[] {
    return Array.from({ length: this.totalPages }, (_, i) => i + 1);
  }

  updatePagedView() {
    const start = (this.currentPage - 1) * this.pageSize;
    this.paged = this.filtered.slice(start, start + this.pageSize);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.updatePagedView();
  }

  nextPage() {
    this.goToPage(this.currentPage + 1);
  }

  prevPage() {
    this.goToPage(this.currentPage - 1);
  }

  get statsTotal() { return this.books.length; }
  get statsActive() { return this.books.filter(b => this.isActive(b)).length; }
  get statsInactive() { return this.statsTotal - this.statsActive; }
  get statsAudio() { return this.books.filter(b => Number(b.eligible_for_audio) === 1).length; }
  get statsMaster() { return this.books.filter(b => b.type === 'Master Book').length; }
  get statsSub() { return this.statsTotal - this.statsMaster; }

  // ============================================================
  // LOOKUPS HELPERS
  // ============================================================

  boardLabel(b: any): string {
    return b.code || b.name || `Board ${b.id}`;
  }

  classOptionLabel(c: any): string {
    return c.name || (c.class_number ? `Class ${c.class_number}` : `Class ${c.id}`);
  }

  classesForBoard(boardId: any): any[] {
    if (boardId === '' || boardId === null || boardId === undefined) return [];
    return this.classes.filter(c => String(c.board_id) === String(boardId));
  }

  subjectsForClass(classId: any): any[] {
    if (classId === '' || classId === null || classId === undefined) return [];
    return this.subjects.filter(s => String(s.class_id) === String(classId));
  }

  boardName(b: any): string {
    const board = this.boards.find(x => String(x.id) === String(b.board_id));
    return board?.name || board?.code || '-';
  }

  className(b: any): string {
    const cls = this.classes.find(x => String(x.id) === String(b.class_id));
    return cls?.name || (cls?.class_number ? `Class ${cls.class_number}` : '-');
  }

  subjectName(b: any): string {
    const subj = this.subjects.find(x => String(x.id) === String(b.subject_id));
    return subj?.name || '';
  }

  publisherLabel(b: any): string {
    const pub = this.publishers.find(x => String(x.id) === String(b.publisher_id));
    return pub?.code || pub?.name || '';
  }

  isActive(b: any): boolean {
    return Number(b.is_active) === 1;
  }

  // ============================================================
  // ADD / EDIT FORM
  // ============================================================

  private emptyForm(): any {
    return {
      board_id: '',
      class_id: '',
      subject_id: '',
      publisher_id: '',
      author_name: '',
      course_type: '',
      code: '',
      name: '',
      language: 'English',
      book_number: 1,
      edition_number: 1,
      edition_start_year: String(new Date().getFullYear()),
      edition_end_year: 'NA',
      type: 'Master Book',
      master_book_id: '',
      no_of_chapters: '',
      eligible_for_audio: 0,
      audio_link: '',
      vikas_alias: '',
      jitendar_alias: '',
      saurabh_alias: '',
      description: '',
      display_order: 0,
      is_active: 1,
      sequence_number: null,
      book_spec: 'publisher'
    };
  }

  initAddForm() {
    this.form = this.emptyForm();
    this.form.sequence_number = this.maxSequence + 1;
    this.formClassOptions = [];
    this.formSubjectOptions = [];
  }

  loadBookForEdit(id: number) {
    this.api.get<any>(`/books/${id}`).subscribe({
      next: r => {
        if (r?.status && r.data) {
          const b = r.data;
          this.form = {
            ...this.emptyForm(),
            ...b,
            board_id: b.board_id ?? '',
            class_id: b.class_id ?? '',
            subject_id: b.subject_id ?? '',
            publisher_id: b.publisher_id ?? '',
            master_book_id: b.master_book_id ?? '',
            no_of_chapters: b.no_of_chapters ?? '',
            sequence_number: b.sequence_number ?? (this.maxSequence + 1),
            book_spec: (b.code || '').startsWith('KEY_') ? 'key' : 'publisher'
          };
          this.formClassOptions = this.classesForBoard(this.form.board_id);
          this.formSubjectOptions = this.subjectsForClass(this.form.class_id);
        } else {
          this.toast.error(r?.message || 'Book not found');
          this.goToList();
        }
      },
      error: () => {
        this.toast.error('Failed to load book');
        this.goToList();
      }
    });
  }

  onFormBoardChange() {
    this.formClassOptions = this.classesForBoard(this.form.board_id);
    this.formSubjectOptions = [];
    this.form.class_id = '';
    this.form.subject_id = '';
    this.regenerateCode();
  }

  onFormClassChange() {
    this.formSubjectOptions = this.subjectsForClass(this.form.class_id);
    this.form.subject_id = '';
    this.regenerateCode();
  }

  // ── Code generator, mirrors the PHP buildCode() logic ──
  buildCode(): string {
    let firstSeg = '';
    if (this.form.book_spec === 'key') {
      firstSeg = 'KEY';
    } else {
      const pub = this.publishers.find(p => String(p.id) === String(this.form.publisher_id));
      firstSeg = (pub?.code || '').substring(0, 3).toUpperCase();
    }

    const lang = this.languages.find(l => l.name === this.form.language);
    const langCode = lang?.code || '';

    const board = this.boards.find(b => String(b.id) === String(this.form.board_id));
    const boardCode = board?.code || '';

    const cls = this.classes.find(c => String(c.id) === String(this.form.class_id));
    const classStr = cls?.class_number ? String(cls.class_number).padStart(2, '0') : '';

    const edYear = String(this.form.edition_start_year || '').trim();

    const subj = this.subjects.find(s => String(s.id) === String(this.form.subject_id));
    const subjCode = subj?.code || '';

    const bookStr = 'B' + String(this.form.book_number || 1).trim();
    const edStr = String(this.form.edition_number || 1).padStart(2, '0');
    const ctVal = String(this.form.course_type || '').trim();

    const parts = [firstSeg, langCode, boardCode, classStr, edYear, subjCode, bookStr, edStr, ctVal];
    return parts.filter(p => p !== '').join('_');
  }

  regenerateCode() {
    const code = this.buildCode();
    if (code) this.form.code = code;
  }

  toggleActive() {
    this.form.is_active = this.form.is_active ? 0 : 1;
  }

  goToAdd() {
    this.router.navigate([], { queryParams: { form: 'add' } });
  }

  goToEdit(b: any) {
    this.router.navigate([], { queryParams: { form: 'edit', id: b.id } });
  }

  goToList() {
    this.router.navigate([], { queryParams: {} });
  }

  goToBookReport(b: any) {
    if (this.auth.user?.role === 'editor') {
      this.toast.error('Access denied');
      return;
    }
    this.router.navigate(['/reports/content'], { queryParams: { book_id: b.id } });
  }

  save() {
    const d = this.form;
    if (!d.board_id || !d.class_id || !d.publisher_id || !d.code?.trim() || !d.name?.trim()) {
      this.toast.error('Board, Class, Publisher, Code and Name are required');
      return;
    }
    if (d.type === 'Sub Book' && !d.master_book_id) {
      this.toast.error('Master Book is required when type is Sub Book');
      return;
    }

    this.saving = true;
    const payload: any = {
      sequence_number: d.sequence_number ? Number(d.sequence_number) : undefined,
      board_id: Number(d.board_id),
      class_id: Number(d.class_id),
      subject_id: d.subject_id ? Number(d.subject_id) : null,
      publisher_id: Number(d.publisher_id),
      author_name: d.author_name || null,
      course_type: d.course_type || null,
      code: d.code,
      name: d.name,
      language: d.language || 'English',
      book_number: Number(d.book_number || 1),
      edition_number: Number(d.edition_number || 1),
      edition_start_year: d.edition_start_year || String(new Date().getFullYear()),
      edition_end_year: d.edition_end_year || 'NA',
      type: d.type || 'Master Book',
      master_book_id: d.master_book_id ? Number(d.master_book_id) : null,
      no_of_chapters: d.no_of_chapters !== '' ? Number(d.no_of_chapters) : null,
      eligible_for_audio: Number(d.eligible_for_audio || 0),
      audio_link: d.audio_link || null,
      vikas_alias: d.vikas_alias || null,
      jitendar_alias: d.jitendar_alias || null,
      saurabh_alias: d.saurabh_alias || null,
      description: d.description || null,
      display_order: Number(d.display_order || 0),
      is_active: Number(d.is_active)
    };

    const req = this.formMode === 'add'
      ? this.api.post<any>('/books', payload)
      : this.api.put<any>(`/books/${this.editId}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.formMode === 'add' ? 'Book created' : 'Book updated');
          BooksComponent.clearCache();
          this.goToList();
        } else {
          this.toast.error(r?.message || 'Operation failed');
        }
      },
      error: () => {
        this.saving = false;
        this.toast.error('Request failed');
      }
    });
  }

  // ============================================================
  // DELETE / TOGGLE
  // ============================================================

  confirmDelete(b: any) {
    if (!this.canDelete) {
      this.toast.error('Access denied');
      return;
    }
    this.deleteConfirm = b;
  }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/books/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) {
          this.toast.success('Book deleted');
          BooksComponent.clearCache();
          this.load();
        } else {
          this.toast.error(r?.message || 'Delete failed');
        }
        this.deleteConfirm = null;
      },
      error: () => {
        this.toast.error('Delete failed');
        this.deleteConfirm = null;
      }
    });
  }

  toggleStatus(b: any) {
    const newVal = this.isActive(b) ? 0 : 1;
    this.api.put<any>(`/books/${b.id}`, { is_active: newVal }).subscribe({
      next: r => {
        if (r?.status) {
          b.is_active = newVal;
          this.toast.success('Status updated');
          if (BooksComponent.cache) {
            const cached = BooksComponent.cache.books.find((x: any) => String(x.id) === String(b.id));
            if (cached) cached.is_active = newVal;
          }
        } else {
          this.toast.error(r?.message || 'Failed to update status');
        }
      },
      error: () => this.toast.error('Failed to update status')
    });
  }

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.boards)) return r.boards;
    if (Array.isArray(r?.classes)) return r.classes;
    if (Array.isArray(r?.subjects)) return r.subjects;
    if (Array.isArray(r?.publishers)) return r.publishers;
    if (Array.isArray(r?.languages)) return r.languages;
    if (Array.isArray(r?.course_types)) return r.course_types;
    if (Array.isArray(r?.books)) return r.books;
    return [];
  }
}