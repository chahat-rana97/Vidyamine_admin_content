import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-chapters',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chapters.component.html',
  styleUrls: ['./chapters.component.css']
})
export class ChaptersComponent implements OnInit {

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

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer
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
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  // ============================================================
  // BOOTSTRAP — load books first, then chapters / form
  // ============================================================

  private bootstrap() {
    this.loadingLookups = true;
    this.api.get<any>('/boards').subscribe({
      next: r => {
        this.boards = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.boards) ? r.boards : []);
        this.loadAllClasses(() => {
          this.loadAllSubjects(() => {
            this.loadBooks();
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
    const calls = this.boards.map(b =>
      new Promise<void>(resolve => {
        this.api.get<any>(`/classes?board_id=${b.id}`).subscribe({
          next: r => {
            const list = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.classes) ? r.classes : []);
            this.classes.push(...list);
            resolve();
          },
          error: () => resolve()
        });
      })
    );
    Promise.all(calls).then(() => {
      const seen = new Map<string, any>();
      for (const c of this.classes) seen.set(String(c.id), c);
      this.classes = Array.from(seen.values());
      done();
    });
  }

  private loadAllSubjects(done: () => void) {
    const calls = this.classes.map(c =>
      new Promise<void>(resolve => {
        this.api.get<any>(`/subjects?class_id=${c.id}`).subscribe({
          next: r => {
            const list = Array.isArray(r?.data) ? r.data : (Array.isArray(r?.subjects) ? r.subjects : []);
            this.subjects.push(...list);
            resolve();
          },
          error: () => resolve()
        });
      })
    );
    Promise.all(calls).then(() => {
      const seen = new Map<string, any>();
      for (const s of this.subjects) seen.set(String(s.id), s);
      this.subjects = Array.from(seen.values());
      done();
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

  load() {
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

      if (this.filterStatus !== '') {
        this.chapters = list.filter((c: any) => String(c.is_active) === this.filterStatus);
      } else {
        this.chapters = list;
      }

      this.buildSequenceOptions();
      this.applyFilter();
      this.loading = false;
    },
    error: () => {
      this.chapters = [];
      this.filtered = [];
      this.loading = false;
      this.toast.error('Failed to load chapters');
    }
  });
}

  onFilterBoardChange() {
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
    this.filterSubjectOptions = this.subjectsForClass(this.filterClassId);
    this.filterSubjectId = '';
    this.filterBookId = '';
    this.filterBookOptions = this.booksFor(this.filterBoardId, this.filterClassId, '');
    this.filterSequence = '';
    this.load();
  }

  onFilterSubjectChange() {
    this.filterBookId = '';
    this.filterBookOptions = this.booksFor(this.filterBoardId, this.filterClassId, this.filterSubjectId);
    this.filterSequence = '';
    this.load();
  }

  onFilterChange() {
    this.filterSequence = '';
    this.load();
  }

  clearFilters() {
    this.filterBoardId = '';
    this.filterClassId = '';
    this.filterSubjectId = '';
    this.filterBookId = '';
    this.filterStatus = '';
    this.filterSequence = '';
    this.filterClassOptions = [];
    this.filterSubjectOptions = [];
    this.filterBookOptions = [...this.books];
    this.load();
  }

  applyFilter() {
    const q   = this.search.trim().toLowerCase();
    const seq = this.filterSequence;

    this.filtered = this.chapters.filter((c: any) => {
      const haystack = [
        c.chapter_code, c.name, c.abbreviation, c.file_name,
        c.book_name, c.book_code, c.checked_by,
        c.book_seq_no, c.sequence, c.confidence
      ].filter(Boolean).join(' ').toLowerCase();

      return (!q || haystack.includes(q)) && (!seq || String(c.sequence) === seq);
    });
  }

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
      book_id: '', sequence: 1, chapter_code: '', name: '',
      abbreviation: '', confidence: 'Unverified',
      file_name: '', book_name: '', checked_by: '', is_active: 1,
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
  }

  loadChapterForEdit(id: number) {
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
      },
      error: (err: any) => {
        this.uploadingPdf = false;
        this.toast.error(err?.error?.message || 'PDF upload failed');
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
      name:         this.form.name.trim(),
      abbreviation: this.form.abbreviation?.trim() || null,
      confidence:   this.form.confidence || 'Unverified',
      file_name:    this.form.file_name?.trim() || null,
      book_name:    this.form.book_name || null,
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
          this.goToList();
        } else {
          this.toast.error(r?.message || 'Operation failed');
        }
      },
      error: () => { this.saving = false; this.toast.error('Request failed'); }
    });
  }

  // ============================================================
  // DELETE / TOGGLE
  // ============================================================

  confirmDelete(c: any) { this.deleteConfirm = c; }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/chapters/${this.deleteConfirm.id}`).subscribe({
      next: (r: any) => {
        if (r?.status) { this.toast.success('Chapter deleted'); this.load(); }
        else { this.toast.error(r?.message || 'Delete failed'); }
        this.deleteConfirm = null;
      },
      error: () => { this.toast.error('Delete failed'); this.deleteConfirm = null; }
    });
  }

  toggleStatus(c: any) {
    const newVal = Number(c.is_active) === 1 ? 0 : 1;
    this.api.put<any>(`/chapters/${c.id}`, { is_active: newVal }).subscribe({
      next: (r: any) => {
        if (r?.status) { c.is_active = newVal; this.toast.success('Status updated'); this.applyFilter(); }
        else { this.toast.error(r?.message || 'Failed to update status'); }
      },
      error: () => this.toast.error('Failed to update status')
    });
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  goToAdd()  { this.router.navigate([], { queryParams: { form: 'add' } }); }
  goToEdit(c: any) { this.router.navigate([], { queryParams: { form: 'edit', id: c.id } }); }
  goToList() { this.router.navigate([], { queryParams: {} }); }
  goToTopics(c: any) { this.router.navigate(['/topics'], { queryParams: { chapter_id: c.id } }); }

  isActive(c: any): boolean { return Number(c.is_active) === 1; }
}