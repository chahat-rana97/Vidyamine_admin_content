import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ViewChildren, QueryList, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import JSZip from 'jszip';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

/**
 * Each topic gets 4 "track" tiles — Script, Slide, Quiz, Exercise.
 * These are UI-only placeholders for now (no backend artifact storage yet).
 * Wiring real generation/attach flows comes later — only the screenshot
 * upload/save/delete is wired to the real API + server folder.
 */
type TrackType = 'script' | 'slide' | 'quiz' | 'exer';

const TRACK_TYPES: TrackType[] = ['script', 'quiz', 'exer', 'slide'];
const TRACK_LABEL: Record<TrackType, string> = {
  script: 'Script', slide: 'Slide', quiz: 'Quiz', exer: 'Exercise'
};
const TRACK_ICON: Record<TrackType, string> = {
  script: '📝', slide: '📊', quiz: '❓', exer: '🧮'
};

/** Hardcoded unlock key for reverting a topic from Final back to Pending.
 *  TODO: move this check server-side once the backend enforces it (the
 *  PUT /topics/{id}/status route already accepts an unlock_key param). */
const FINAL_UNLOCK_KEY = 'vmunlock23';

/**
 * Slide-tile document types. Each maps to a DB column + a filename
 * suffix that the uploaded file's basename must exactly match:
 *   {topic_code}{suffix}.{ext}
 */
type SlideDocType = 'claude_ppt' | 'gpt_ppt' | 'claude_pdf';

interface SlideDocDef {
  type: SlideDocType;
  label: string;
  suffix: string;       // appended to topic_code to form the required filename base
  exts: string[];       // allowed extensions (lowercase, no dot)
  field: string;         // property name on the topic row holding the saved filename
}

const SLIDE_DOC_TYPES: SlideDocType[] = ['claude_ppt', 'gpt_ppt', 'claude_pdf'];
const SLIDE_DOC_DEFS: Record<SlideDocType, SlideDocDef> = {
  // .pptx only (not legacy binary .ppt) — the Compare view renders PPTX
  // client-side and cannot render old binary .ppt files at all.
  claude_ppt: { type: 'claude_ppt', label: 'Claude PPT',  suffix: '_GPT_Clau_PPT', exts: ['pptx'], field: 'slide_claude_ppt' },
  claude_pdf: { type: 'claude_pdf', label: 'Claude PDF',  suffix: '_GPT_Clau_PDF', exts: ['pdf'],  field: 'slide_claude_pdf' },
  gpt_ppt:    { type: 'gpt_ppt',    label: 'ChatGPT PPT', suffix: '_GPT_Chat_PPT', exts: ['pptx'], field: 'slide_gpt_ppt' },
  // claude_pdf: { type: 'claude_pdf', label: 'Claude PDF',  suffix: '_GPT_Clau_PDF', exts: ['pdf'],         field: 'slide_claude_pdf' },
};

/** One shape / drawing stroke / sticky note on the annotation layer. Coordinates
 *  are stored in "natural image pixel" space (0,0 = top-left of the original
 *  image at 100% zoom) so the layer stays correctly positioned at any zoom level. */
interface AnnoElement {
  id: string;
  type: 'pen' | 'rect' | 'circle' | 'line' | 'arrow' | 'note';
  color: string;
  strokeWidth?: number;
  // pen: array of {x,y} points
  points?: { x: number; y: number }[];
  // rect/circle/line/arrow: bounding box in image space
  x?: number; y?: number; w?: number; h?: number;
  x2?: number; y2?: number;
  // note
  text?: string;
  noteColor?: string;
}

type AnnoTool = 'select' | 'pen' | 'rect' | 'circle' | 'line' | 'arrow' | 'note' | 'eraser';

interface ImportItem {
  _uid: string;
  file: File;
  originalName: string;
  topicNo: string;
  detectedCode: string;
  matches: boolean;
  parseError: string;
  resolved: boolean;
  previewUrl: string;
}

@Component({
  selector: 'app-topics',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './topics.component.html',
  styleUrls: ['./topics.component.css']
})
export class TopicsComponent implements OnInit, AfterViewInit, OnDestroy {

  // Screenshots are served from / uploaded to this folder on the server.
  // Base API origin (without the /dev_chahat/getadminvm api path) + Screenshots dir.
  readonly SCREENSHOT_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/Screenshots';

  // Chapter PDFs live in this folder — same one used by the Chapters screen.
  readonly PDF_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/ch_pdfs';
  uploadingPdf = false;
  pdfViewerUrl: SafeResourceUrl | null = null;
  pdfViewerTitle: string = '';

  // ── Slide-tile documents (Claude PPT / ChatGPT PPT / Claude PDF) ──
  readonly ATTACH_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/topic_attachments';
  SLIDE_DOC_TYPES = SLIDE_DOC_TYPES;
  SLIDE_DOC_DEFS = SLIDE_DOC_DEFS;

  // Modal state for the currently open slide-doc popup (null = closed)
  slideDocModal: {
    topic: any;
    def: SlideDocDef;
    stage: 'view' | 'upload';       // 'view' if a file already exists, 'upload' otherwise
    pickedFile: File | null;
    pickedName: string;             // basename (no ext) of the picked file, for the mismatch check
    pickedExt: string;
    nameMatches: boolean;
    uploading: boolean;
    deleting: boolean;
  } | null = null;

  // ── Screenshot ZIP export ──
  exportingZip = false;
  exportProgress = 0; // 0-100, for the progress UI

  TRACK_TYPES = TRACK_TYPES;
  TRACK_LABEL = TRACK_LABEL;
  TRACK_ICON = TRACK_ICON;

  // ── Route context ──
  chapterId: number | null = null;
  chapter: any = null;

  // ── List state ──
  topics: any[] = [];
  loading = false;
  loadingChapter = false;

  // ── Per-row UI state (for screenshot upload in-flight, captions saving, etc.) ──
  uploadingTopicId: { [topicId: number]: boolean } = {};
  savingCaption: { [topicId: number]: boolean } = {};
  autofillingTopicId: { [topicId: number]: boolean } = {};
  fillingAllCaptions = false;

  // ── Assignable users (for the "assign to" dropdown + filter) ──
  assignableUsers: any[] = [];
  loadingUsers = false;
  assigningTopicId: { [topicId: number]: boolean } = {};

  // ── Combined filter: '' = all, 'status:final' / 'status:pending', or 'user:<id>' ──
  topicFilter: string = '';
  filteredTopics: any[] = [];

  // ── Final <-> Pending status change, unlock modal state ──
  savingStatusId: { [topicId: number]: boolean } = {};
  unlockModal: { open: boolean; topic: any | null; keyInput: string; error: string } = {
    open: false, topic: null, keyInput: '', error: ''
  };

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer
  ) {}

  /**
   * Opens the full-screen Compare view for a topic. Left/right doc types
   * are picked inside that screen (it shows its own picker on first load),
   * so we only need to pass the topic_id here.
   */
  openCompareView(topic: any) {
    this.router.navigate(['/compare'], { queryParams: { topic_id: topic.id } });
  }

  ngOnInit() {
    const idParam = this.route.snapshot.queryParamMap.get('chapter_id')
      || this.route.snapshot.paramMap.get('chapter_id');
    this.chapterId = idParam ? Number(idParam) : null;

    if (!this.chapterId) {
      this.toast.error('No chapter selected');
      this.goBackToChapters();
      return;
    }

    this.loadChapter();
    this.load();
    this.loadAssignableUsers();
  }

  get canWrite() {
    return ['superadmin', 'admin', 'editor'].includes(this.auth.user?.role || '');
  }

  get canDelete() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  // ============================================================
  // LOAD
  // ============================================================

  loadChapter() {
    this.loadingChapter = true;
    this.api.get<any>(`/chapters/${this.chapterId}`).subscribe({
      next: (r: any) => {
        this.chapter = r?.data || null;
        this.loadingChapter = false;
      },
      error: () => {
        this.loadingChapter = false;
        this.toast.error('Failed to load chapter');
      }
    });
  }

  // ============================================================
  // CHAPTER PDF — view / upload / replace (same file used on Chapters screen)
  // ============================================================

  /** Builds the public URL for a stored chapter file_name (base name, no extension). */
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

  triggerChapterPdfPicker(input: HTMLInputElement) {
    input.value = '';
    input.click();
  }

  onChapterPdfSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      this.toast.error('Please select a PDF file');
      return;
    }

    if (!this.chapterId) return;

    const formData = new FormData();
    formData.append('chapter_id', String(this.chapterId));
    formData.append('file_name', this.chapter?.file_name || this.chapter?.chapter_code || '');
    formData.append('file', file, file.name);

    this.uploadingPdf = true;
    this.api.post<any>('/chapters/upload-pdf', formData).subscribe({
      next: (r: any) => {
        this.uploadingPdf = false;
        if (r?.status) {
          if (this.chapter) this.chapter.file_name = r.file_name;
          this.toast.success('Chapter PDF uploaded');
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

  /** Opens the in-app popup viewer for the chapter PDF, or triggers the
   *  file picker if none is attached yet. */
  openOrAddChapterPdf(picker: HTMLInputElement) {
    if (this.chapter?.file_name) {
      this.openPdfViewer(this.chapter.file_name);
    } else if (this.canWrite) {
      this.triggerChapterPdfPicker(picker);
    } else {
      this.toast.error('No PDF attached to this chapter');
    }
  }

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
  // EXPORT ALL SCREENSHOTS AS A ZIP (folder-per-topic)
  // ============================================================
  //
  // Produces a single .zip download containing one subfolder per topic
  // (named after that topic's topic_code), each holding all of that
  // topic's screenshot image files. Images are fetched client-side from
  // SCREENSHOT_BASE as blobs and packed with JSZip — no backend endpoint
  // required since the files are already publicly served.

  async exportScreenshotsZip() {
    if (this.exportingZip) return;

    const topicsWithShots = this.topics.filter(t => t._screenshots && t._screenshots.length);
    if (!topicsWithShots.length) {
      this.toast.error('No screenshots to export for this chapter');
      return;
    }

    this.exportingZip = true;
    this.exportProgress = 0;

    try {
      const zip = new JSZip();

      const chapterFolderName = this.sanitizeForFsName(
        this.chapter?.chapter_code || this.chapter?.name || `chapter_${this.chapterId}`
      );
      const root = zip.folder(chapterFolderName)!;

      // Total file count across all topics, for progress reporting.
      const totalFiles = topicsWithShots.reduce((sum, t) => sum + t._screenshots.length, 0);
      let doneFiles = 0;

      for (const t of topicsWithShots) {
        const topicFolderName = this.sanitizeForFsName(t.topic_code || `topic_${t.id}`);
        const topicFolder = root.folder(topicFolderName)!;

        for (const filename of t._screenshots as string[]) {
          try {
            const blob = await this.fetchAsBlob(this.screenshotUrl(filename));
            topicFolder.file(filename, blob);
          } catch (e) {
            // Skip files that fail to fetch (e.g. missing on server) but keep going.
            console.error('Failed to fetch screenshot for zip:', filename, e);
          }
          doneFiles++;
          this.exportProgress = Math.round((doneFiles / totalFiles) * 100);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadName = `${chapterFolderName}_screenshots.zip`;
      this.triggerBlobDownload(zipBlob, downloadName);
      this.toast.success('Screenshots exported');
    } catch (e) {
      console.error('Zip export failed:', e);
      this.toast.error('Failed to export screenshots');
    } finally {
      this.exportingZip = false;
      this.exportProgress = 0;
    }
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

  /** Strips characters that are unsafe in folder/file names on most OSes. */
  private sanitizeForFsName(name: string): string {
    return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
  }

  load() {
    this.loading = true;
    this.api.get<any>(`/topics?chapter_id=${this.chapterId}`).subscribe({
      next: (r: any) => {
        const list = Array.isArray(r?.data) ? r.data : [];
        list.sort((a: any, b: any) => Number(a.sequence) - Number(b.sequence));
        this.topics = list.map((t: any) => this.hydrateTopic(t));
        this.applyTopicFilter();
        this.loading = false;
      },
      error: () => {
        this.topics = [];
        this.filteredTopics = [];
        this.loading = false;
        this.toast.error('Failed to load topics');
      }
    });
  }

  loadAssignableUsers() {
    this.loadingUsers = true;
    this.api.get<any>('/admin/users-assignable').subscribe({
      next: (r: any) => {
        this.assignableUsers = Array.isArray(r?.data) ? r.data : [];
        this.loadingUsers = false;
      },
      error: () => { this.loadingUsers = false; }
    });
  }

  /** Applies the combined user/status filter dropdown to `this.topics` -> `this.filteredTopics`. */
  applyTopicFilter() {
    if (!this.topicFilter) {
      this.filteredTopics = this.topics;
      return;
    }
    if (this.topicFilter === 'status:final') {
      this.filteredTopics = this.topics.filter(t => t.topic_status === 'final');
    } else if (this.topicFilter === 'status:pending') {
      this.filteredTopics = this.topics.filter(t => (t.topic_status || 'pending') === 'pending');
    } else if (this.topicFilter.startsWith('user:')) {
      const uid = this.topicFilter.slice(5);
      this.filteredTopics = this.topics.filter(t => String(t.assigned_to) === uid);
    } else {
      this.filteredTopics = this.topics;
    }
  }

  onTopicFilterChange() { this.applyTopicFilter(); }

  /** Adds UI-only scaffolding (tracks placeholder, parsed screenshots array) onto a raw topic row. */
  private hydrateTopic(t: any): any {
    let screenshots: string[] = [];
    if (t.screenshots) {
      try {
        const parsed = JSON.parse(t.screenshots);
        if (Array.isArray(parsed)) screenshots = parsed;
      } catch {
        // not JSON — ignore
      }
    }
    return {
      ...t,
      topic_status: t.topic_status || 'pending',
      _screenshots: screenshots,
      _tracks: TRACK_TYPES.reduce((acc, type) => {
        acc[type] = { status: 'empty', versions: [] };
        return acc;
      }, {} as any)
    };
  }

  // ── Stats ──
  get statsTotalTopics() { return this.topics.length; }
  get statsActiveTopics() { return this.topics.filter(t => Number(t.is_active) === 1).length; }
  get statsTotalScreenshots() {
    return this.topics.reduce((sum, t) => sum + (t._screenshots?.length || 0), 0);
  }
  get statsDoneArtifacts() {
    // Placeholder — wire to real artifact counts once tracks are backed by API.
    return 0;
  }
  get statsTotalSlots() { return this.topics.length * TRACK_TYPES.length; }

  screenshotUrl(filename: string): string {
    if (!filename) return '';
    return `${this.SCREENSHOT_BASE}/${filename}`;
  }

  // ============================================================
  // ADD TOPIC — now driven by importing pre-named screenshot files.
  // Filenames on disk are expected as {NN}_{chapter_code}[_extra].ext
  // Clicking "Add new topic" opens the system file picker (multi-select).
  // Each selected file is parsed, checked against this chapter's code,
  // and grouped by topic number. Any mismatch or gap surfaces a review
  // panel before anything is sent to the server.
  // ============================================================

  triggerImportPicker(pickerEl: HTMLInputElement) {
    if (!this.chapter) {
      this.toast.error('Chapter not loaded yet');
      return;
    }
    pickerEl.value = '';
    pickerEl.click();
  }

  // ── Import review state ──
  importReview: {
    chapterCode: string;
    items: ImportItem[];
    missingNos: string[];
  } | null = null;
  importSubmitting = false;

  onImportFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || !fileList.length) return;

    const chapterCode = (this.chapter?.chapter_code || '').trim();
    const files = Array.from(fileList);

    const items: ImportItem[] = files.map((file, idx) => this.parseImportFile(file, idx, chapterCode));
    const missingNos = this.computeMissingTopicNumbers(items);

    this.importReview = { chapterCode, items, missingNos };
    input.value = '';
  }

  /** Parses one selected file's name into a topic number + chapter-code match state. */
  private parseImportFile(file: File, idx: number, chapterCode: string): ImportItem {
    const nameNoExt = file.name.replace(/\.[^.]+$/, '');
    // Expected: NN_{chapter_code...} — NN is leading digits, rest is the chapter-code portion.
    const m = nameNoExt.match(/^(\d{1,2})_(.+)$/);

    let topicNo = '';
    let detectedCode = '';
    let parseError = '';

    if (!m) {
      parseError = 'Filename doesn\'t match the expected {NN}_{chapter_code} pattern';
    } else {
      topicNo = m[1].padStart(2, '0');
      detectedCode = m[2];
    }

    const matches = !!m && detectedCode === chapterCode;

    return {
      _uid: `imp_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
      file,
      originalName: file.name,
      topicNo,
      detectedCode,
      matches,
      parseError,
      resolved: matches,
      previewUrl: URL.createObjectURL(file)
    };
  }

  /** Recomputes which topic numbers (1..max) are missing among currently-resolved items. */
  private computeMissingTopicNumbers(items: ImportItem[]): string[] {
    const nos = items
      .filter(it => it.resolved && it.topicNo)
      .map(it => parseInt(it.topicNo, 10))
      .filter(n => !isNaN(n));

    if (!nos.length) return [];

    const maxNo = Math.max(...nos);
    const present = new Set(nos);
    const missing: string[] = [];
    for (let n = 1; n <= maxNo; n++) {
      if (!present.has(n)) missing.push(String(n).padStart(2, '0'));
    }
    return missing;
  }

  get importHasUnresolved(): boolean {
    return !!this.importReview?.items.some(it => !it.resolved);
  }

  get importResolvedCount(): number {
    return this.importReview?.items.filter(it => it.resolved).length || 0;
  }

  /**
   * User directly edits the filename text for a mismatched/unrecognized item.
   * Re-parses it the same way an on-disk file would be, but forces the
   * chapter-code portion to the current chapter's code (since renaming here
   * is specifically to fix the code, not to move the file to another chapter).
   */
  applyRename(it: ImportItem, newName: string) {
    const chapterCode = this.importReview?.chapterCode || '';
    const cleanedName = (newName || '').trim();

    if (!cleanedName) {
      this.toast.error('Enter a filename');
      return;
    }

    const nameNoExt = cleanedName.replace(/\.[^.]+$/, '');
    const m = nameNoExt.match(/^(\d{1,2})_/);

    if (!m) {
      this.toast.error('Name must start with a 2-digit topic number, e.g. 05_' + chapterCode);
      return;
    }

    it.topicNo = m[1].padStart(2, '0');
    it.detectedCode = chapterCode;
    it.matches = true;
    it.resolved = true;
    it.parseError = '';
    it.originalName = cleanedName + (it.originalName.match(/\.[^.]+$/)?.[0] || '');
    this.refreshImportGaps();
  }

  /** Quick-fix: user only wants to reassign the topic number, keeping detected code as-is (forced to match). */
  applyTopicNoOnly(it: ImportItem, newTopicNo: string) {
    const cleaned = (newTopicNo || '').replace(/\D/g, '').slice(0, 2);
    if (!cleaned) {
      this.toast.error('Enter a valid topic number');
      return;
    }
    it.topicNo = cleaned.padStart(2, '0');
    it.detectedCode = this.importReview?.chapterCode || it.detectedCode;
    it.matches = true;
    it.resolved = true;
    it.parseError = '';
    this.refreshImportGaps();
  }

  /** Skips (excludes) a problem item from the import rather than fixing it. */
  skipImportItem(it: ImportItem) {
    if (!this.importReview) return;
    if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
    this.importReview.items = this.importReview.items.filter(x => x._uid !== it._uid);
    this.refreshImportGaps();
  }

  private refreshImportGaps() {
    if (!this.importReview) return;
    this.importReview.missingNos = this.computeMissingTopicNumbers(this.importReview.items);
  }

  cancelImport() {
    this.importReview?.items.forEach(it => it.previewUrl && URL.revokeObjectURL(it.previewUrl));
    this.importReview = null;
  }

  /** User acknowledges the gap warning and proceeds anyway (leaves the gap). */
  confirmImportDespiteGaps() {
    this.submitImport(true);
  }

  submitImport(gapsAcknowledged: boolean = false) {
    if (!this.importReview) return;

    if (this.importHasUnresolved) {
      this.toast.error('Resolve or skip all highlighted items before importing');
      return;
    }
    if (this.importReview.missingNos.length && !gapsAcknowledged) {
      // Safety net — UI should show the gap-confirm prompt before reaching here.
      return;
    }
    if (!this.importReview.items.length) {
      this.toast.error('No files to import');
      return;
    }

    this.importSubmitting = true;

    const formData = new FormData();
    formData.append('chapter_id', String(this.chapterId));
    this.importReview.items.forEach(it => {
      formData.append('files[]', it.file, it.originalName);
      formData.append('topic_no[]', it.topicNo);
    });

    this.api.post<any>('/topics/bulk-import-screenshots', formData).subscribe({
      next: (r: any) => {
        this.importSubmitting = false;
        if (r?.status) {
          const count = Array.isArray(r.data) ? r.data.length : 0;
          this.toast.success(`Imported screenshots for ${count} topic(s)`);
          this.cancelImport();
          this.load();
        } else {
          this.toast.error(r?.message || 'Import failed');
        }
      },
      error: (err: any) => {
        this.importSubmitting = false;
        this.toast.error(err?.error?.message || 'Import failed');
      }
    });
  }

  // ============================================================
  // CAPTION (name) EDIT — inline, saved on blur
  // ============================================================

  saveCaption(t: any) {
    if (!t.id) return;
    this.savingCaption[t.id] = true;
    this.api.put<any>(`/topics/${t.id}`, { name: t.name || '' }).subscribe({
      next: (r: any) => {
        this.savingCaption[t.id] = false;
        if (!r?.status) this.toast.error(r?.message || 'Failed to save caption');
      },
      error: () => {
        this.savingCaption[t.id] = false;
        this.toast.error('Failed to save caption');
      }
    });
  }

  // ============================================================
  // AI CAPTION AUTOFILL (Gemini) — single topic + bulk
  // ============================================================

  /**
   * Calls the backend to generate a short AI caption for this topic
   * (based on its first screenshot) and saves it.
   */
  autofillCaption(t: any) {
    if (!t || !t.id) {
      console.error('[autofillCaption] called without a valid topic / topic.id', t);
      this.toast.error('Cannot auto-fill: topic has no id');
      return;
    }

    if (!t._screenshots || !t._screenshots.length) {
      this.toast.error('Add a screenshot before auto-filling the caption');
      return;
    }

    if (this.autofillingTopicId[t.id]) {
      // already in flight, ignore double-click
      return;
    }

    console.log('[autofillCaption] requesting caption for topic', t.id);
    this.autofillingTopicId[t.id] = true;

    this.api.post<any>(`/topics/${t.id}/autofill-caption`, {}).subscribe({
      next: (r: any) => {
        this.autofillingTopicId[t.id] = false;
        console.log('[autofillCaption] response', r);
        if (r?.status && r?.data?.name) {
          t.name = r.data.name;
          this.toast.success('Caption generated');
        } else {
          this.toast.error(r?.message || 'Failed to generate caption');
        }
      },
      error: (err: any) => {
        this.autofillingTopicId[t.id] = false;
        console.error('[autofillCaption] error', err);
        this.toast.error(err?.error?.message || 'Failed to generate caption');
      }
    });
  }

  /**
   * Runs autofillCaption() sequentially for every topic with an empty
   * caption that has at least one screenshot.
   */
  fillAllEmptyCaptions() {
    const candidates = this.topics.filter(
      t => (!t.name || !t.name.trim()) && t._screenshots && t._screenshots.length
    );

    if (!candidates.length) {
      this.toast.success('No empty captions with screenshots to fill');
      return;
    }

    if (this.fillingAllCaptions) return;
    this.fillingAllCaptions = true;

    this.toast.success(`Filling ${candidates.length} caption(s)…`);

    const runNext = (index: number) => {
      if (index >= candidates.length) {
        this.fillingAllCaptions = false;
        return;
      }
      const t = candidates[index];
      this.autofillingTopicId[t.id] = true;
      this.api.post<any>(`/topics/${t.id}/autofill-caption`, {}).subscribe({
        next: (r: any) => {
          this.autofillingTopicId[t.id] = false;
          if (r?.status && r?.data?.name) {
            t.name = r.data.name;
          }
          runNext(index + 1);
        },
        error: () => {
          this.autofillingTopicId[t.id] = false;
          runNext(index + 1);
        }
      });
    };

    runNext(0);
  }

  // ============================================================
  // SEQUENCE / REORDER
  // ============================================================

  moveTopic(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= this.topics.length) return;
    [this.topics[index], this.topics[j]] = [this.topics[j], this.topics[index]];
    this.topics.forEach((t, i) => t.sequence = i + 1);
    this.persistReorder();
  }

  /** Real index of a topic within the unfiltered `this.topics` array — used by
   *  the move up/down buttons, which are disabled whenever a filter is active. */
  topicIndex(t: any): number {
    return this.topics.findIndex(x => x.id === t.id);
  }

  private persistReorder() {
    const payload = {
      chapter_id: this.chapterId,
      topics: this.topics.map(t => ({ id: t.id, sequence: t.sequence }))
    };
    this.api.post<any>('/topics/reorder', payload).subscribe({
      next: (r: any) => {
        if (!r?.status) this.toast.error(r?.message || 'Reorder failed');
      },
      error: () => this.toast.error('Reorder failed')
    });
  }

  // ============================================================
  // SCREENSHOT UPLOAD / DELETE
  // Saves to server folder /Screenshots with the original filename,
  // then stores that filename in chapter_topics.screenshots (JSON array).
  // ============================================================

  triggerUpload(t: any, fileInput: HTMLInputElement) {
    fileInput.click();
  }

  onFileSelected(t: any, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploadingTopicId[t.id] = true;

    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('topic_id', String(t.id));
    formData.append('chapter_id', String(this.chapterId));

    // Dedicated upload endpoint expected on the backend (multipart),
    // saving with the original filename into the Screenshots folder
    // and returning the stored filename.
    this.api.post<any>('/topics/upload-screenshot', formData).subscribe({
      next: (r: any) => {
        this.uploadingTopicId[t.id] = false;
        if (r?.status) {
          const savedName = r.filename || file.name;
          t._screenshots = [...(t._screenshots || []), savedName];
          this.persistScreenshots(t);
          this.toast.success('Screenshot uploaded');
        } else {
          this.toast.error(r?.message || 'Upload failed');
        }
        input.value = '';
      },
      error: () => {
        this.uploadingTopicId[t.id] = false;
        this.toast.error('Upload failed');
        input.value = '';
      }
    });
  }

  removeScreenshot(t: any, index: number) {
    t._screenshots = (t._screenshots || []).filter((_: any, i: number) => i !== index);
    this.persistScreenshots(t);
  }

  private persistScreenshots(t: any) {
    this.api.put<any>(`/topics/${t.id}`, {
      screenshots: JSON.stringify(t._screenshots || [])
    }).subscribe({
      next: (r: any) => {
        if (!r?.status) this.toast.error(r?.message || 'Failed to save screenshots');
      },
      error: () => this.toast.error('Failed to save screenshots')
    });
  }

  // ============================================================
  // TRACK TILE ACTIONS — UI only for now
  // ============================================================

  trackFast(t: any, type: TrackType) {
    this.toast.success(`Fast generate (${TRACK_LABEL[type]}) — coming soon`);
  }

  trackDetailed(t: any, type: TrackType) {
    this.toast.success(`Detailed generate (${TRACK_LABEL[type]}) — coming soon`);
  }

  trackAttach(t: any, type: TrackType) {
    this.toast.success(`Attach (${TRACK_LABEL[type]}) — coming soon`);
  }

  // ============================================================
  // SLIDE-TILE DOCUMENTS (Claude PPT / ChatGPT PPT / Claude PDF)
  // Saves to server folder /topic_attachments, filename must be
  // exactly {topic_code}{suffix}.{ext} — enforced client + server side.
  // ============================================================

  /** True if this topic already has a file saved for the given doc type. */
  slideDocAttached(t: any, docType: SlideDocType): boolean {
    const def = SLIDE_DOC_DEFS[docType];
    return !!(t && t[def.field]);
  }

  slideDocFilename(t: any, docType: SlideDocType): string {
    const def = SLIDE_DOC_DEFS[docType];
    return t ? (t[def.field] || '') : '';
  }

  slideDocUrl(filename: string): string {
    if (!filename) return '';
    return `${this.ATTACH_BASE}/${filename}`;
  }

  /** Sanitized version of slideDocUrl() for use in an iframe [src] binding. */
  slideDocSafeUrl(filename: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.slideDocUrl(filename));
  }

  /** Expected filename base (no extension) for a given topic + doc type. */
  expectedSlideDocBase(t: any, docType: SlideDocType): string {
    const def = SLIDE_DOC_DEFS[docType];
    return `${t.topic_code}${def.suffix}`;
  }

  /** Opens the popup for a Slide-tile doc button. */
  openSlideDocModal(t: any, docType: SlideDocType) {
    const def = SLIDE_DOC_DEFS[docType];
    const hasFile = this.slideDocAttached(t, docType);
    this.slideDocModal = {
      topic: t,
      def,
      stage: hasFile ? 'view' : 'upload',
      pickedFile: null,
      pickedName: '',
      pickedExt: '',
      nameMatches: false,
      uploading: false,
      deleting: false
    };
  }

  closeSlideDocModal() {
    this.slideDocModal = null;
  }

  /** Switches an already-attached doc's modal into "replace" (upload) mode. */
  slideDocSwitchToUpload() {
    if (!this.slideDocModal) return;
    this.slideDocModal.stage = 'upload';
    this.slideDocModal.pickedFile = null;
    this.slideDocModal.pickedName = '';
    this.slideDocModal.pickedExt = '';
    this.slideDocModal.nameMatches = false;
  }

  slideDocBackToView() {
    if (!this.slideDocModal) return;
    this.slideDocModal.stage = 'view';
    this.slideDocModal.pickedFile = null;
  }

  triggerSlideDocPicker(fileInput: HTMLInputElement) {
    fileInput.click();
  }

  /** Runs when a file is chosen in the upload stage — validates the name, no upload yet. */
  onSlideDocFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.slideDocModal) return;

    const dot = file.name.lastIndexOf('.');
    const base = dot !== -1 ? file.name.substring(0, dot) : file.name;
    const ext = dot !== -1 ? file.name.substring(dot + 1).toLowerCase() : '';

    const expectedBase = this.expectedSlideDocBase(this.slideDocModal.topic, this.slideDocModal.def.type);
    const extOk = this.slideDocModal.def.exts.includes(ext);

    this.slideDocModal.pickedFile = file;
    this.slideDocModal.pickedName = base;
    this.slideDocModal.pickedExt = ext;
    this.slideDocModal.nameMatches = (base === expectedBase) && extOk;
  }

  /** User clicks "Rename & Continue" on a mismatched file — renames it in-memory to the expected name. */
  slideDocFixName() {
    if (!this.slideDocModal || !this.slideDocModal.pickedFile) return;
    const m = this.slideDocModal;
    const originalFile = m.pickedFile!; // narrowed to File here, unlike m.pickedFile below
    const expectedBase = this.expectedSlideDocBase(m.topic, m.def.type);

    // Keep the original extension if it's one of the allowed ones, otherwise
    // default to the first allowed extension for this doc type.
    const ext = m.def.exts.includes(m.pickedExt) ? m.pickedExt : m.def.exts[0];
    const fixedName = `${expectedBase}.${ext}`;

    const renamed = new File([originalFile], fixedName, { type: originalFile.type });

    m.pickedFile = renamed;
    m.pickedName = expectedBase;
    m.pickedExt = ext;
    m.nameMatches = true;
  }

  slideDocCancelPickedFile() {
    if (!this.slideDocModal) return;
    this.slideDocModal.pickedFile = null;
    this.slideDocModal.pickedName = '';
    this.slideDocModal.pickedExt = '';
    this.slideDocModal.nameMatches = false;
  }

  /** Confirms upload — only enabled once nameMatches is true. */
  confirmSlideDocUpload() {
    const m = this.slideDocModal;
    if (!m || !m.pickedFile || !m.nameMatches || m.uploading) return;

    const fileToUpload = m.pickedFile; // narrowed to File, avoids TS2322 below

    m.uploading = true;
    const formData = new FormData();
    formData.append('file', fileToUpload, fileToUpload.name);
    formData.append('topic_id', String(m.topic.id));
    formData.append('doc_type', m.def.type);

    this.api.post<any>('/topics/upload-slide-doc', formData).subscribe({
      next: (r: any) => {
        if (m) m.uploading = false;
        if (r?.status) {
          m.topic[m.def.field] = r.filename;
          this.toast.success(`${m.def.label} attached`);
          this.closeSlideDocModal();
        } else {
          this.toast.error(r?.message || 'Upload failed');
        }
      },
      error: (e: any) => {
        if (m) m.uploading = false;
        const msg = e?.error?.message || 'Upload failed';
        this.toast.error(msg);
      }
    });
  }

  deleteSlideDoc() {
    const m = this.slideDocModal;
    if (!m || m.deleting) return;
    if (!confirm(`Remove ${m.def.label} from this topic? This deletes the file from the server.`)) return;

    m.deleting = true;
    this.api.post<any>(`/topics/${m.topic.id}/delete-slide-doc`, { doc_type: m.def.type }).subscribe({
      next: (r: any) => {
        if (m) m.deleting = false;
        if (r?.status) {
          m.topic[m.def.field] = null;
          this.toast.success(`${m.def.label} removed`);
          this.closeSlideDocModal();
        } else {
          this.toast.error(r?.message || 'Delete failed');
        }
      },
      error: () => {
        if (m) m.deleting = false;
        this.toast.error('Delete failed');
      }
    });
  }

  downloadSlideDoc(t: any, docType: SlideDocType) {
    const filename = this.slideDocFilename(t, docType);
    if (!filename) return;
    const url = this.slideDocUrl(filename);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============================================================
  // STATUS TOGGLE / DELETE
  // ============================================================

  toggleStatus(t: any) {
    const newVal = Number(t.is_active) === 1 ? 0 : 1;
    this.api.put<any>(`/topics/${t.id}`, { is_active: newVal }).subscribe({
      next: (r: any) => {
        if (r?.status) { t.is_active = newVal; this.toast.success('Status updated'); }
        else this.toast.error(r?.message || 'Failed to update status');
      },
      error: () => this.toast.error('Failed to update status')
    });
  }

  // ============================================================
  // FINAL / PENDING TOPIC STATUS
  // ============================================================

  isFinal(t: any): boolean { return t.topic_status === 'final'; }

  /** Click handler on the Final/Pending badge. Marking Final is immediate;
   *  reverting Final -> Pending opens the unlock-key modal first. */
  onStatusBadgeClick(t: any) {
    if (!this.isFinal(t)) {
      this.setTopicStatus(t, 'final');
    } else {
      this.openUnlockModal(t);
    }
  }

  private setTopicStatus(t: any, status: 'pending' | 'final', unlockKey?: string) {
    this.savingStatusId[t.id] = true;
    this.api.put<any>(`/topics/${t.id}/status`, { status, unlock_key: unlockKey || null }).subscribe({
      next: (r: any) => {
        this.savingStatusId[t.id] = false;
        if (r?.status) {
          t.topic_status = status;
          t.status_by = this.auth.user?.name || t.status_by;
          this.toast.success(status === 'final' ? 'Marked as Final' : 'Reverted to Pending');
          this.applyTopicFilter();
        } else {
          this.toast.error(r?.message || 'Failed to update status');
        }
      },
      error: () => { this.savingStatusId[t.id] = false; this.toast.error('Failed to update status'); }
    });
  }

  openUnlockModal(t: any) {
    this.unlockModal = { open: true, topic: t, keyInput: '', error: '' };
  }

  closeUnlockModal() {
    this.unlockModal = { open: false, topic: null, keyInput: '', error: '' };
  }

  confirmUnlock() {
    const t = this.unlockModal.topic;
    if (!t) return;
    if (this.unlockModal.keyInput !== FINAL_UNLOCK_KEY) {
      this.unlockModal.error = 'Incorrect key. Try again.';
      return;
    }
    this.setTopicStatus(t, 'pending', this.unlockModal.keyInput);
    this.closeUnlockModal();
  }

  // ============================================================
  // TOPIC ASSIGNMENT
  // ============================================================

  onAssigneeChange(t: any, userId: any) {
    if (!userId) {
      this.unassignTopic(t);
      return;
    }
    this.assigningTopicId[t.id] = true;
    this.api.put<any>(`/topics/${t.id}/assign`, { assigned_to: userId }).subscribe({
      next: (r: any) => {
        this.assigningTopicId[t.id] = false;
        if (r?.status) {
          t.assigned_to = userId;
          const u = this.assignableUsers.find(x => String(x.id) === String(userId));
          t.assigned_to_name = u?.name || t.assigned_to_name;
          this.toast.success(`Assigned to ${t.assigned_to_name || 'user'}`);
          this.applyTopicFilter();
        } else {
          this.toast.error(r?.message || 'Failed to assign topic');
        }
      },
      error: () => { this.assigningTopicId[t.id] = false; this.toast.error('Failed to assign topic'); }
    });
  }

  unassignTopic(t: any) {
    this.assigningTopicId[t.id] = true;
    this.api.delete<any>(`/topics/${t.id}/assign`).subscribe({
      next: (r: any) => {
        this.assigningTopicId[t.id] = false;
        if (r?.status) {
          t.assigned_to = null;
          t.assigned_to_name = null;
          this.toast.success('Topic unassigned');
          this.applyTopicFilter();
        } else {
          this.toast.error(r?.message || 'Failed to unassign topic');
        }
      },
      error: () => { this.assigningTopicId[t.id] = false; this.toast.error('Failed to unassign topic'); }
    });
  }

  deleteConfirm: any = null;
  confirmDelete(t: any) { this.deleteConfirm = t; }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/topics/${this.deleteConfirm.id}`).subscribe({
      next: (r: any) => {
        if (r?.status) { this.toast.success('Topic deleted'); this.load(); }
        else this.toast.error(r?.message || 'Delete failed');
        this.deleteConfirm = null;
      },
      error: () => { this.toast.error('Delete failed'); this.deleteConfirm = null; }
    });
  }

  isActive(t: any): boolean { return Number(t.is_active) === 1; }

  // ============================================================
  // YOUTUBE LINK — add / edit / delete / open
  // ============================================================

  ytEditingId: any = null;
  ytLinkDraft: string = '';
  savingYoutubeLink: { [id: string]: boolean } = {};

  /** Opens the topic's saved YouTube link in a new browser tab. */
  openYoutubeLink(t: any) {
    if (!t.youtube_link) return;
    window.open(t.youtube_link, '_blank', 'noopener');
  }

  /** Switches the row into inline-edit mode for the YouTube link. */
  startEditYoutubeLink(t: any) {
    this.ytEditingId = t.id;
    this.ytLinkDraft = t.youtube_link || '';
  }

  cancelEditYoutubeLink() {
    this.ytEditingId = null;
    this.ytLinkDraft = '';
  }

  /** Saves (adds or updates) the YouTube link for this topic. */
  saveYoutubeLink(t: any) {
    const link = (this.ytLinkDraft || '').trim();

    if (link && !/^https?:\/\//i.test(link)) {
      this.toast.error('Please enter a valid link starting with http:// or https://');
      return;
    }

    this.savingYoutubeLink[t.id] = true;
    this.api.put<any>(`/topics/${t.id}`, { youtube_link: link || null }).subscribe({
      next: (r: any) => {
        this.savingYoutubeLink[t.id] = false;
        if (r?.status) {
          t.youtube_link = link || null;
          this.toast.success(link ? 'Video link saved' : 'Video link removed');
          this.cancelEditYoutubeLink();
        } else {
          this.toast.error(r?.message || 'Failed to save video link');
        }
      },
      error: () => {
        this.savingYoutubeLink[t.id] = false;
        this.toast.error('Failed to save video link');
      }
    });
  }

  /** Clears the YouTube link for this topic. */
  removeYoutubeLink(t: any) {
    this.savingYoutubeLink[t.id] = true;
    this.api.put<any>(`/topics/${t.id}`, { youtube_link: null }).subscribe({
      next: (r: any) => {
        this.savingYoutubeLink[t.id] = false;
        if (r?.status) {
          t.youtube_link = null;
          this.toast.success('Video link removed');
          this.cancelEditYoutubeLink();
        } else {
          this.toast.error(r?.message || 'Failed to remove video link');
        }
      },
      error: () => {
        this.savingYoutubeLink[t.id] = false;
        this.toast.error('Failed to remove video link');
      }
    });
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  goBackToChapters() {
    this.router.navigate(['/chapters']);
  }

  // ============================================================
  // SCREENSHOT LIGHTBOX VIEWER — zoom + pan + caption edit + remove
  // ============================================================

  lightboxTopic: any = null;
  lightboxIndex: number = -1;
  lbZoomLevel = 1;

  // Pan offset (in screen pixels) applied to the image wrapper.
  lbPanX = 0;
  lbPanY = 0;
  private lbPanning = false;
  private lbPanStartX = 0;
  private lbPanStartY = 0;
  private lbPanOriginX = 0;
  private lbPanOriginY = 0;

  get lightboxFilename(): string {
    return this.lightboxTopic?._screenshots?.[this.lightboxIndex] || '';
  }

  openLightbox(t: any, index: number) {
    this.lightboxTopic = t;
    this.lightboxIndex = index;
    this.lbZoomLevel = 1;
    this.lbPanX = 0;
    this.lbPanY = 0;
    this.closeAnnoBar();
    this.loadAnnotations();
  }

  closeLightbox() {
    this.lightboxTopic = null;
    this.lightboxIndex = -1;
    this.closeAnnoBar();
    this.disconnectAllNoteResizeObservers();
  }

  lbZoom(dir: -1 | 0 | 1) {
    if (dir === 0) {
      this.lbZoomLevel = 1;
      this.lbPanX = 0;
      this.lbPanY = 0;
      return;
    }
    this.lbZoomLevel = Math.min(5, Math.max(0.2, this.lbZoomLevel + dir * 0.2));
  }

  /** Mouse-wheel / trackpad pinch zoom, centered roughly where the cursor is. */
  onLbWheel(event: WheelEvent) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    this.lbZoomLevel = Math.min(5, Math.max(0.2, this.lbZoomLevel + delta));
  }

  /** Click-and-drag panning of the viewport (does NOT create a copy — just offsets the image). */
  onLbPanStart(event: MouseEvent) {
    // Don't pan while a drawing tool other than 'select' is active — those clicks draw instead.
    if (this.annoBarOpen && this.annoTool !== 'select') return;
    this.lbPanning = true;
    this.lbPanStartX = event.clientX;
    this.lbPanStartY = event.clientY;
    this.lbPanOriginX = this.lbPanX;
    this.lbPanOriginY = this.lbPanY;
    event.preventDefault();
  }

  onLbPanMove(event: MouseEvent) {
    if (!this.lbPanning) return;
    this.lbPanX = this.lbPanOriginX + (event.clientX - this.lbPanStartX);
    this.lbPanY = this.lbPanOriginY + (event.clientY - this.lbPanStartY);
  }

  onLbPanEnd() {
    this.lbPanning = false;
  }

  saveCaptionFromLightbox() {
    if (!this.lightboxTopic) return;
    this.saveCaption(this.lightboxTopic);
    this.toast.success('Caption saved');
  }

  removeScreenshotFromLightbox() {
    if (!this.lightboxTopic || this.lightboxIndex < 0) return;
    this.removeScreenshot(this.lightboxTopic, this.lightboxIndex);
    this.closeLightbox();
  }

  // ============================================================
  // ANNOTATIONS — draw shapes/lines/pen strokes + sticky notes on
  // top of the screenshot, saved as a layer in chapter_topics.screenshot_annotations
  // (one layer per filename, via /topics/{id}/annotations).
  // ============================================================

  annoBarOpen = false;
  annoTool: AnnoTool = 'select';
  annoColor = '#ff4757';
  annoStrokeWidth = 3;
  annoElements: AnnoElement[] = [];
  annoLoading = false;
  annoSaving = false;
  annoSelectedId: string | null = null;

  // In-progress draw state
  private annoDrawing = false;
  private annoDraft: AnnoElement | null = null;

  // ── Undo / Redo history (snapshot-based; simple and safe for this element count) ──
  private annoUndoStack: AnnoElement[][] = [];
  private annoRedoStack: AnnoElement[][] = [];
  private readonly ANNO_HISTORY_LIMIT = 50;

  get canUndo(): boolean { return this.annoUndoStack.length > 0; }
  get canRedo(): boolean { return this.annoRedoStack.length > 0; }

  /** Call BEFORE mutating annoElements, to snapshot the pre-mutation state. */
  private pushAnnoHistory() {
    this.annoUndoStack.push(this.annoElements.map(e => ({ ...e, points: e.points ? e.points.map(p => ({ ...p })) : undefined })));
    if (this.annoUndoStack.length > this.ANNO_HISTORY_LIMIT) this.annoUndoStack.shift();
    this.annoRedoStack = [];
  }

  undoAnno() {
    if (!this.canUndo) return;
    this.annoRedoStack.push(this.annoElements);
    this.annoElements = this.annoUndoStack.pop()!;
    this.annoSelectedId = null;
  }

  redoAnno() {
    if (!this.canRedo) return;
    this.annoUndoStack.push(this.annoElements);
    this.annoElements = this.annoRedoStack.pop()!;
    this.annoSelectedId = null;
  }

  private resetAnnoHistory() {
    this.annoUndoStack = [];
    this.annoRedoStack = [];
  }

  // Natural (unscaled) size of the loaded image, needed to convert
  // between screen pixels and image-space coordinates.
  annoImgNaturalW = 0;
  annoImgNaturalH = 0;

  onLbImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    this.applyImageNaturalSize(img);
  }

  /** Reads natural size off an <img> element. Called both from (load) and
   *  from a manual check right after the lightbox opens, because a cached
   *  image may never fire 'load' again (or may fire before Angular has
   *  bound *ngIf on the SVG), which was leaving annoImgNaturalW/H at 0 and
   *  the drawing overlay invisible/zero-sized on the first screenshot opened. */
  private applyImageNaturalSize(img: HTMLImageElement | null | undefined) {
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) {
      this.annoImgNaturalW = img.naturalWidth;
      this.annoImgNaturalH = img.naturalHeight;
    }
  }

  @ViewChild('lbImgEl') set lbImgElRef(ref: ElementRef<HTMLImageElement> | undefined) {
    // Fires whenever the *ngIf/img element is (re)created — covers the case
    // where the browser had the image cached and 'load' never fires.
    if (ref?.nativeElement) {
      this.applyImageNaturalSize(ref.nativeElement);
    }
  }

  // ── Sticky note DOM refs (for resize tracking — see observeNoteResize) ──
  @ViewChildren('noteBox') noteBoxes!: QueryList<ElementRef<HTMLElement>>;

  ngAfterViewInit(): void {
    // Re-sync observers every time the *ngFor list of note boxes changes
    // (opening a screenshot, adding/deleting a note, switching screenshots).
    this.noteBoxes.changes.subscribe((list: QueryList<ElementRef<HTMLElement>>) => {
      this.syncNoteResizeObservers(list);
    });
    // Initial pass in case notes are already present on first render.
    this.syncNoteResizeObservers(this.noteBoxes);
  }

  private syncNoteResizeObservers(list: QueryList<ElementRef<HTMLElement>>) {
    const seenIds = new Set<string>();
    list.forEach(ref => {
      const nativeEl = ref.nativeElement;
      const id = nativeEl.getAttribute('data-note-id');
      if (!id) return;
      seenIds.add(id);
      if (!this.noteResizeObservers.has(id)) {
        const el = this.annoElements.find(e => e.id === id);
        if (el) this.observeNoteResize(nativeEl, el);
      }
    });
    // Drop observers for notes that no longer exist in the DOM.
    Array.from(this.noteResizeObservers.keys()).forEach(id => {
      if (!seenIds.has(id)) this.disconnectNoteResizeObserver(id);
    });
  }

  ngOnDestroy(): void {
    this.disconnectAllNoteResizeObservers();
  }

  toggleAnnoBar() {
    this.annoBarOpen = !this.annoBarOpen;
    if (!this.annoBarOpen) {
      this.annoTool = 'select';
      this.annoSelectedId = null;
    }
  }

  closeAnnoBar() {
    this.annoBarOpen = false;
    this.annoTool = 'select';
    this.annoSelectedId = null;
    this.annoElements = [];
    this.resetAnnoHistory();
    this.disconnectAllNoteResizeObservers();
  }

  setAnnoTool(tool: AnnoTool) {
    this.annoTool = tool;
    this.annoSelectedId = null;
  }

  private loadAnnotations() {
    if (!this.lightboxTopic?.id || !this.lightboxFilename) return;
    this.annoLoading = true;
    this.api.get<any>(
      `/topics/${this.lightboxTopic.id}/annotations?filename=${encodeURIComponent(this.lightboxFilename)}`
    ).subscribe({
      next: (r: any) => {
        this.annoLoading = false;
        this.annoElements = (r?.status && Array.isArray(r?.data?.elements)) ? r.data.elements : [];
        this.resetAnnoHistory();
      },
      error: () => {
        this.annoLoading = false;
        this.annoElements = [];
        this.resetAnnoHistory();
      }
    });
  }

  saveAnnotations() {
    if (!this.lightboxTopic?.id || !this.lightboxFilename) return;
    this.annoSaving = true;
    this.api.put<any>(`/topics/${this.lightboxTopic.id}/annotations`, {
      filename: this.lightboxFilename,
      elements: this.annoElements
    }).subscribe({
      next: (r: any) => {
        this.annoSaving = false;
        if (r?.status) this.toast.success('Notes & drawings saved');
        else this.toast.error(r?.message || 'Failed to save annotations');
      },
      error: () => {
        this.annoSaving = false;
        this.toast.error('Failed to save annotations');
      }
    });
  }

  clearAllAnnotations() {
    if (!this.lightboxTopic?.id || !this.lightboxFilename) return;
    if (!confirm('Clear all drawings and notes on this screenshot?')) return;

    this.pushAnnoHistory();
    this.annoElements = [];
    this.annoSelectedId = null;
    this.annoDrawing = false;
    this.annoDraft = null;
    this.disconnectAllNoteResizeObservers();

    // Use the same PUT save path as saveAnnotations() (proven to work) rather
    // than DELETE-with-body, which some HTTP client wrappers don't support.
    this.annoSaving = true;
    this.api.put<any>(`/topics/${this.lightboxTopic.id}/annotations`, {
      filename: this.lightboxFilename,
      elements: []
    }).subscribe({
      next: (r: any) => {
        this.annoSaving = false;
        if (r?.status) this.toast.success('Layer cleared');
        else this.toast.error(r?.message || 'Failed to clear layer');
      },
      error: () => {
        this.annoSaving = false;
        this.toast.error('Failed to clear layer');
      }
    });
  }

  deleteAnnoElement(id: string) {
    this.pushAnnoHistory();
    this.annoElements = this.annoElements.filter(e => e.id !== id);
    if (this.annoSelectedId === id) this.annoSelectedId = null;
    this.disconnectNoteResizeObserver(id);
  }

  selectAnnoElement(id: string, event?: MouseEvent) {
    if (event) event.stopPropagation();
    if (this.annoTool !== 'select') return;
    this.annoSelectedId = id;
  }

  addNoteAt(imgX: number, imgY: number) {
    this.pushAnnoHistory();
    const el: AnnoElement = {
      id: this.annoUid(),
      type: 'note',
      color: this.annoColor,
      x: imgX, y: imgY, w: 180, h: 110,
      text: '',
      noteColor: this.annoColor
    };
    this.annoElements.push(el);
    this.annoSelectedId = el.id;
    this.annoTool = 'select';
  }

  private annoUid(): string {
    return 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** Converts a mouse event's page coords to image-space (natural pixel) coords,
   *  accounting for current zoom + pan + the wrapper's on-screen position. */
  private toImageCoords(event: MouseEvent, wrapEl: HTMLElement): { x: number; y: number } {
    const rect = wrapEl.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    return {
      x: screenX / this.lbZoomLevel,
      y: screenY / this.lbZoomLevel
    };
  }

  onAnnoCanvasMouseDown(event: MouseEvent, wrapEl: HTMLElement) {
    if (!this.annoBarOpen || this.annoTool === 'select') return;
    const p = this.toImageCoords(event, wrapEl);

    if (this.annoTool === 'note') {
      this.addNoteAt(p.x, p.y);
      return;
    }

    this.annoDrawing = true;

    if (this.annoTool === 'pen') {
      this.annoDraft = {
        id: this.annoUid(), type: 'pen', color: this.annoColor,
        strokeWidth: this.annoStrokeWidth, points: [{ x: p.x, y: p.y }]
      };
    } else if (this.annoTool === 'rect' || this.annoTool === 'circle') {
      this.annoDraft = {
        id: this.annoUid(), type: this.annoTool, color: this.annoColor,
        strokeWidth: this.annoStrokeWidth, x: p.x, y: p.y, w: 0, h: 0
      };
    } else if (this.annoTool === 'line' || this.annoTool === 'arrow') {
      this.annoDraft = {
        id: this.annoUid(), type: this.annoTool, color: this.annoColor,
        strokeWidth: this.annoStrokeWidth, x: p.x, y: p.y, x2: p.x, y2: p.y
      };
    }
    event.preventDefault();
  }

  onAnnoCanvasMouseMove(event: MouseEvent, wrapEl: HTMLElement) {
    if (!this.annoDrawing || !this.annoDraft) return;
    const p = this.toImageCoords(event, wrapEl);

    if (this.annoDraft.type === 'pen') {
      this.annoDraft.points!.push({ x: p.x, y: p.y });
    } else if (this.annoDraft.type === 'rect' || this.annoDraft.type === 'circle') {
      this.annoDraft.w = p.x - (this.annoDraft.x || 0);
      this.annoDraft.h = p.y - (this.annoDraft.y || 0);
    } else if (this.annoDraft.type === 'line' || this.annoDraft.type === 'arrow') {
      this.annoDraft.x2 = p.x;
      this.annoDraft.y2 = p.y;
    }
  }

  onAnnoCanvasMouseUp() {
    if (this.annoDrawing && this.annoDraft) {
      // Normalize negative width/height rects so x,y is always top-left.
      if ((this.annoDraft.type === 'rect' || this.annoDraft.type === 'circle')) {
        let { x = 0, y = 0, w = 0, h = 0 } = this.annoDraft;
        if (w < 0) { x = x + w; w = Math.abs(w); }
        if (h < 0) { y = y + h; h = Math.abs(h); }
        this.annoDraft.x = x; this.annoDraft.y = y; this.annoDraft.w = w; this.annoDraft.h = h;
      }
      this.pushAnnoHistory();
      this.annoElements.push(this.annoDraft);
    }
    this.annoDrawing = false;
    this.annoDraft = null;
  }

  get annoDraftPreview(): AnnoElement | null {
    return this.annoDraft;
  }

  /** Builds an SVG path 'd' attribute string from a pen stroke's points. */
  penPath(el: AnnoElement): string {
    if (!el.points || !el.points.length) return '';
    return el.points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
  }

  // ── Sticky note dragging (move the whole note by its header, in image-space px) ──
  private noteDragging: AnnoElement | null = null;
  private noteDragStartX = 0;
  private noteDragStartY = 0;
  private noteDragOriginX = 0;
  private noteDragOriginY = 0;
  private noteDragMoved = false;

  onNoteDragStart(event: MouseEvent, el: AnnoElement) {
    if (!this.annoBarOpen) return;
    event.stopPropagation();
    event.preventDefault();
    this.annoSelectedId = el.id;
    this.pushAnnoHistory(); // snapshot pre-drag position once, at the start of the gesture
    this.noteDragging = el;
    this.noteDragStartX = event.clientX;
    this.noteDragStartY = event.clientY;
    this.noteDragOriginX = el.x || 0;
    this.noteDragOriginY = el.y || 0;
    this.noteDragMoved = false;
  }

  onNoteDragMove(event: MouseEvent) {
    if (!this.noteDragging) return;
    const dx = (event.clientX - this.noteDragStartX) / this.lbZoomLevel;
    const dy = (event.clientY - this.noteDragStartY) / this.lbZoomLevel;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) this.noteDragMoved = true;
    this.noteDragging.x = this.noteDragOriginX + dx;
    this.noteDragging.y = this.noteDragOriginY + dy;
  }

  onNoteDragEnd() {
    this.noteDragging = null;
    this.noteDragMoved = false;
  }

  // ── Sticky note resize (native CSS `resize: both` handle) ──
  // The browser resize handle changes the note <div>'s on-screen box directly;
  // it never touches our AnnoElement model. We watch each note with a
  // ResizeObserver, convert the observed on-screen box back into natural
  // image-space pixels (dividing out the current zoom level), and write the
  // result into el.w / el.h — so Save persists the real size and Undo has a
  // correct pre-resize snapshot to restore.
  private noteResizeObservers = new Map<string, ResizeObserver>();
  private noteResizeHistoryPushed = new Set<string>();
  private noteResizeCommitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Called from the template via a ref callback / directive on each .anno-note div. */
  observeNoteResize(noteEl: HTMLElement, el: AnnoElement) {
    if (!noteEl || el.type !== 'note') return;
    if (this.noteResizeObservers.has(el.id)) return; // already observing this note

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const boxW = entry.contentRect.width;
        const boxH = entry.contentRect.height;
        const newW = Math.round(boxW / this.lbZoomLevel);
        const newH = Math.round(boxH / this.lbZoomLevel);

        if (newW <= 0 || newH <= 0) continue;
        if (el.w === newW && el.h === newH) continue;

        // First change in a resize gesture: snapshot history once, before we
        // touch the model, so Undo restores the pre-resize size correctly.
        if (!this.noteResizeHistoryPushed.has(el.id)) {
          this.pushAnnoHistory();
          this.noteResizeHistoryPushed.add(el.id);
        }

        el.w = newW;
        el.h = newH;

        // Debounce marking the gesture "finished" — resets once the box
        // stops changing for a short period (mouseup on the resize handle
        // doesn't fire a distinct DOM event we can hook reliably).
        const existingTimer = this.noteResizeCommitTimers.get(el.id);
        if (existingTimer) clearTimeout(existingTimer);
        this.noteResizeCommitTimers.set(el.id, setTimeout(() => {
          this.noteResizeHistoryPushed.delete(el.id);
          this.noteResizeCommitTimers.delete(el.id);
        }, 400));
      }
    });

    ro.observe(noteEl);
    this.noteResizeObservers.set(el.id, ro);
  }

  private disconnectNoteResizeObserver(id: string) {
    const ro = this.noteResizeObservers.get(id);
    if (ro) { ro.disconnect(); this.noteResizeObservers.delete(id); }
    const timer = this.noteResizeCommitTimers.get(id);
    if (timer) { clearTimeout(timer); this.noteResizeCommitTimers.delete(id); }
    this.noteResizeHistoryPushed.delete(id);
  }

  private disconnectAllNoteResizeObservers() {
    this.noteResizeObservers.forEach(ro => ro.disconnect());
    this.noteResizeObservers.clear();
    this.noteResizeCommitTimers.forEach(t => clearTimeout(t));
    this.noteResizeCommitTimers.clear();
    this.noteResizeHistoryPushed.clear();
  }
}