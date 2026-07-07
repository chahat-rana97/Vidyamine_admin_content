import { Component, OnInit, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import * as pdfjsLib from 'pdfjs-dist';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

// pdfjs needs its worker script location set once, at module load. The file
// is copied into /public/assets/pdf.worker.min.mjs at build time and must be
// the SAME pdfjs-dist version as the npm package (check with
// pdfjsLib.version if you ever see silent hangs after upgrading the package).
//
// The path is resolved against the app's actual <base href> rather than
// hardcoded to "/" — a hardcoded root path only works when the app is
// hosted at its domain's root (e.g. localhost:4200). On GitHub Pages (or
// any deployment served from a subpath, e.g.
// https://user.github.io/repo-name/), the real app root is
// "/repo-name/", so "/assets/..." resolves to the wrong (404ing) URL.
// Angular writes the deployed base path into <base href> at build time
// (via --base-href / angular.json), so reading it here keeps this correct
// in every environment without needing an environment-specific constant.
const cvBaseHref = (document.querySelector('base')?.getAttribute('href') || '/').replace(/\/$/, '');
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = `${cvBaseHref}/assets/pdf.worker.min.mjs`;

/** The four kinds of "document" that can appear in either pane. */
export type CompareDocType = 'screenshots' | 'claude_ppt' | 'gpt_ppt' | 'claude_pdf';

export const COMPARE_DOC_LABEL: Record<CompareDocType, string> = {
  screenshots: 'Screenshots',
  claude_ppt: 'Claude PPT',
  gpt_ppt: 'ChatGPT PPT',
  claude_pdf: 'Claude PDF'
};

/** One renderable "page" inside a pane, regardless of source type. */
interface PaneItem {
  pageKey: string;
  label: string;
  imageUrl?: string;
}

/**
 * A pin's x/y is always stored and compared in "natural page pixel space" —
 * i.e. the pixel coordinates of the page/slide/screenshot at its own
 * intrinsic 100%-zoom size, NOT the size it happens to be displayed at on
 * screen. This lets pins line up correctly no matter how the surface is
 * scaled by CSS (e.g. `max-width: 100%` shrinking a canvas or image down
 * to fit the pane). Every surface type needs to report its natural size
 * so we can convert click coordinates <-> stored coordinates.
 */
interface NaturalSize {
  width: number;
  height: number;
}

interface CommentPin {
  id: number;
  topic_id: number;
  doc_type: CompareDocType;
  page_key: string;
  x: number | null;
  y: number | null;
  text: string;
  author: string | null;
  resolved: boolean | number;
  created_at: string;
  updated_at: string;
}

/**
 * "Mark Final" state for one specific page/slide/screenshot (topic_id +
 * doc_type + page_key). Separate from comments — this is a single flag per
 * item, not a thread — so it's tracked in its own map instead of being
 * folded into CommentPin.
 */
interface ItemStatus {
  id?: number;
  topic_id: number;
  doc_type: CompareDocType;
  page_key: string;
  is_final: boolean | number;
  marked_by: string | null;
  updated_at?: string;
}

/** Runtime state for one side (left or right) of the split view. */
interface PaneState {
  docType: CompareDocType | null;
  loading: boolean;
  error: string;
  items: PaneItem[];
  activeIndex: number;
  pdfDoc: any | null;
  pptxBytes: ArrayBuffer | null;
  needsPptxOnly: boolean; // true if attached file is a legacy .ppt (blocked)
  /** Natural (unscaled) pixel size of the currently-displayed page/slide/screenshot, used to convert click <-> stored pin coordinates. Null until known. */
  naturalSize: NaturalSize | null;
  /** True while a PDF page is actively being rasterized, so the UI can show a per-page spinner instead of a blank/white canvas. */
  pageRendering: boolean;
  /** Zoom level for this pane's viewing surface (1 = 100%). Purely a CSS-transform scale on top of the existing render pipeline — does not affect natural-size pin math. */
  zoom: number;
  /** Real aspect ratio (width/height) of the loaded .pptx's slides, read from the file itself once known. Used to size every slide canvas correctly instead of assuming 16:9. Null until a pptx has been loaded. */
  pptxAspectRatio: number | null;
}

@Component({
  selector: 'app-compare-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './compare-view.component.html',
  styleUrls: ['./compare-view.component.css']
})
export class CompareViewComponent implements OnInit, OnDestroy {

  // All document bytes are streamed through the API (same-origin), never
  // fetched directly from the static topic_attachments/Screenshots folders.
  // Screenshots are the one exception: they're rendered via plain <img src>,
  // which doesn't invoke CORS at all, so the static URL is fine there.
  readonly SCREENSHOT_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/Screenshots';
  readonly API_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm';

  readonly DOC_LABEL = COMPARE_DOC_LABEL;

  topicId: number | null = null;
  topic: any = null;
  loadingTopic = false;

  pickerOpen = true;
  pickerLeft: CompareDocType | null = null;
  pickerRight: CompareDocType | null = null;

  left: PaneState = this.emptyPane();
  right: PaneState = this.emptyPane();

  @ViewChild('splitWrap') splitWrapRef!: ElementRef<HTMLDivElement>;
  leftWidthPct = 50;
  private dragging = false;

  comments: CommentPin[] = [];
  loadingComments = false;
  newCommentText = '';
  activePaneSide: 'left' | 'right' = 'left';

  /** Which single page/slide/screenshot currently has its comment box open — accordion-style, one at a time. */
  openBox: { side: 'left' | 'right'; index: number } | null = null;
  /** id of the comment currently being edited inline inside its attached box, if any. */
  editingCommentId: number | null = null;
  editingText = '';

  /** Which pane (if any) is maximized to fill the split view, hiding the other pane/divider/comments panel. */
  fullscreenSide: 'left' | 'right' | null = null;

  /**
   * Independent show/hide toggles for the three columns of the compare view
   * (left pane, right pane, comments panel) — driven by the three header
   * buttons. Distinct from fullscreenSide: fullscreen dedicates the whole
   * split view to one pane, whereas these let any combination of the three
   * columns be hidden (e.g. "just the two panes, no comments").
   */
  leftPaneOpen = true;
  rightPaneOpen = true;
  commentsPanelOpen = true;

  /** Mark-final status per item, keyed by `${doc_type}::${page_key}`. */
  itemStatuses: Record<string, ItemStatus> = {};

  // pptxViewer instances declared below, next to the render logic they support.

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  private emptyPane(): PaneState {
    return {
      docType: null, loading: false, error: '', items: [], activeIndex: 0,
      pdfDoc: null, pptxBytes: null, needsPptxOnly: false,
      naturalSize: null, pageRendering: false, zoom: 1, pptxAspectRatio: null
    };
  }

  ngOnInit() {
    const idParam = this.route.snapshot.queryParamMap.get('topic_id');
    this.topicId = idParam ? Number(idParam) : null;

    const leftParam = this.route.snapshot.queryParamMap.get('left') as CompareDocType | null;
    const rightParam = this.route.snapshot.queryParamMap.get('right') as CompareDocType | null;

    if (!this.topicId) {
      this.toast.error('No topic selected for comparison');
      this.router.navigate(['/dashboard']);
      return;
    }

    // If both sides came in via the URL, skip the picker — but this must
    // wait for loadTopic()'s API call, since confirmPicker() -> loadPane()
    // reads this.topic.slide_* fields.
    if (leftParam && rightParam) {
      this.pickerLeft = leftParam;
      this.pickerRight = rightParam;
      this.loadTopic(() => this.confirmPicker());
    } else {
      this.loadTopic();
    }
  }

  ngOnDestroy() {
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
  }

  get canWrite() {
    return ['superadmin', 'admin', 'editor'].includes(this.auth.user?.role || '');
  }

  goBack() {
    if (this.topic?.chapter_id) {
      this.router.navigate(['/topics'], { queryParams: { chapter_id: this.topic.chapter_id } });
    } else {
      window.history.back();
    }
  }

  // ============================================================
  // LOAD TOPIC
  // ============================================================

  loadTopic(onLoaded?: () => void) {
    this.loadingTopic = true;
    this.api.get<any>(`/topics/${this.topicId}`).subscribe({
      next: (r: any) => {
        this.topic = r?.data || null;
        this.loadingTopic = false;
        if (onLoaded) onLoaded();
      },
      error: () => {
        this.loadingTopic = false;
        this.toast.error('Failed to load topic');
      }
    });
  }

  get availableDocTypes(): CompareDocType[] {
    if (!this.topic) return [];
    const out: CompareDocType[] = [];
    if (this.topic.screenshots) {
      const shots = this.parseJsonArray(this.topic.screenshots);
      if (shots.length) out.push('screenshots');
    }
    if (this.topic.slide_claude_ppt) out.push('claude_ppt');
    if (this.topic.slide_gpt_ppt) out.push('gpt_ppt');
    if (this.topic.slide_claude_pdf) out.push('claude_pdf');
    return out;
  }

  private parseJsonArray(val: any): string[] {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
  }

  // ============================================================
  // PICKER
  // ============================================================

  openPicker() {
    this.pickerOpen = true;
  }

  choosePickerSide(side: 'left' | 'right', docType: CompareDocType) {
    if (side === 'left') this.pickerLeft = docType;
    else this.pickerRight = docType;
  }

  get pickerValid(): boolean {
    return !!this.pickerLeft && !!this.pickerRight && this.pickerLeft !== this.pickerRight;
  }

  confirmPicker() {
    if (!this.pickerValid) return;
    this.pickerOpen = false;
    this.left = this.emptyPane();
    this.right = this.emptyPane();
    this.left.docType = this.pickerLeft;
    this.right.docType = this.pickerRight;
    this.pptxViewer = {};
    this.loadPane('left');
    this.loadPane('right');
  }

  // ============================================================
  // PANE LOADING
  // ============================================================

  private paneOf(side: 'left' | 'right'): PaneState {
    return side === 'left' ? this.left : this.right;
  }

  paneOfPublic(side: 'left' | 'right'): PaneState {
    return this.paneOf(side);
  }

  async loadPane(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    if (!pane.docType || !this.topic) return;

    pane.loading = true;
    pane.error = '';
    pane.items = [];
    pane.activeIndex = 0;

    try {
      if (pane.docType === 'screenshots') {
        this.loadScreenshotsPane(pane);
      } else if (pane.docType === 'claude_pdf') {
        await this.loadPdfPane(pane, this.topic.slide_claude_pdf, side);
      } else if (pane.docType === 'claude_ppt' || pane.docType === 'gpt_ppt') {
        const filename = pane.docType === 'claude_ppt' ? this.topic.slide_claude_ppt : this.topic.slide_gpt_ppt;
        await this.loadPptxPane(pane, filename, side);
      }
    } catch (e: any) {
      pane.error = e?.message || 'Failed to load document';
    } finally {
      pane.loading = false;
      this.loadCommentsFor(side);
      this.loadItemStatusesFor(side);
    }
  }

  private loadScreenshotsPane(pane: PaneState) {
    const shots = this.parseJsonArray(this.topic.screenshots);
    pane.items = shots.map((fn: string) => ({
      pageKey: fn,
      label: fn,
      imageUrl: `${this.SCREENSHOT_BASE}/${fn}`
    }));
    if (!pane.items.length) pane.error = 'No screenshots uploaded for this topic yet.';
    pane.naturalSize = null; // recorded by onScreenshotLoad() once the <img> actually loads
  }

  /** Fired from the template's (load) on the screenshot <img> — records its true pixel size for pin math. */
  /** Param typed loosely because the template passes $event.target, which TypeScript types as EventTarget | null. */
  onScreenshotLoad(side: 'left' | 'right', target: EventTarget | null) {
    if (!(target instanceof HTMLImageElement)) return;
    const pane = this.paneOf(side);
    pane.naturalSize = { width: target.naturalWidth, height: target.naturalHeight };
  }

  // ============================================================
  // PDF
  // ============================================================

  private async loadPdfPane(pane: PaneState, filename: string | null, side: 'left' | 'right') {
    if (!filename) { pane.error = 'No Claude PDF attached yet.'; return; }

    const url = `${this.API_BASE}/topics/${this.topicId}/slide-doc/claude_pdf`;

    // Fetch the bytes ourselves first (instead of handing pdf.js a bare URL)
    // so we get one clear, consistent error path for network/HTTP failures,
    // and so pdf.js only ever sees either good bytes or nothing at all.
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e: any) {
      pane.error = 'Could not reach the server to download the PDF. Check your connection and try again.';
      return;
    }
    if (!res.ok) {
      if (res.status === 404) {
        pane.error = 'This PDF is missing on the server.';
      } else {
        pane.error = `Failed to download the PDF (HTTP ${res.status}).`;
      }
      return;
    }
    const bytes = await res.arrayBuffer();

    if (bytes.byteLength < 5 || !this.looksLikePdf(bytes)) {
      pane.error = 'The stored PDF file appears to be corrupted or incomplete. Please re-upload it.';
      return;
    }

    let pdf: any;
    try {
      // disableAutoFetch/disableStream: for large PDFs, fetching page N
      // shouldn't have to wait on the whole file streaming in first — this
      // matters most for the "long PDF shows white pages" symptom, since
      // without it pdf.js can stall on pages deep into a big document.
      const loadingTask = (pdfjsLib as any).getDocument({
        data: bytes,
        disableAutoFetch: false,
        disableStream: false
      });
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out opening the PDF.')), 30000)
      );
      pdf = await Promise.race([loadingTask.promise, timeout]);
    } catch (e: any) {
      pane.error = 'Failed to open the PDF: ' + (e?.message || 'unknown error');
      return;
    }

    pane.pdfDoc = pdf;
    pane.items = Array.from({ length: pdf.numPages }, (_, i) => ({
      pageKey: `page-${i + 1}`,
      label: `Page ${i + 1}`
    }));

    // Data is ready — flip loading off NOW so Angular can mount the
    // *ngIf="!loading"-gated canvas element. If we wait until after
    // waitForElement() (which the outer loadPane() would otherwise do, in
    // its finally block), the canvas never appears during the poll because
    // it's still hidden behind that same *ngIf, and the poll gives up.
    pane.loading = false;
    await this.waitForElement(this.pdfCanvasId(side, 0));
    await this.renderAllPdfPages(pane, side);
  }

  /** Canvas id for a specific PDF page index within a side's vertical list (page 0 keeps the original id so nothing else that references it breaks). */
  private pdfCanvasId(side: 'left' | 'right', index: number): string {
    const base = side === 'left' ? 'leftPdfCanvas' : 'rightPdfCanvas';
    return index === 0 ? base : `${base}-${index}`;
  }

  /**
   * Renders every page of the PDF into its own canvas, one after another, so
   * the pane can show the whole document as a scrollable vertical list
   * (rather than one page at a time). Reuses renderPdfPage()'s per-page
   * logic unchanged, just looped across all indices with a per-index canvas id.
   */
  async renderAllPdfPages(pane: PaneState, side: 'left' | 'right') {
    for (let i = 0; i < pane.items.length; i++) {
      await this.waitForElement(this.pdfCanvasId(side, i));
      await this.renderPdfPage(pane, i);
    }
  }

  /** Checks the first bytes for the "%PDF" signature every valid PDF starts with. */
  private looksLikePdf(bytes: ArrayBuffer): boolean {
    const head = new Uint8Array(bytes.slice(0, 5));
    const str = String.fromCharCode(...head);
    return str.startsWith('%PDF');
  }

  // Guards against overlapping renders: if the user navigates quickly
  // (Next/Prev, thumbnail clicks, or a slow page deep in a long PDF), an
  // older in-flight render can finish AFTER a newer one starts and either
  // paint over it, or reset canvas.width/height mid-paint on the newer
  // render — either way the pane ends up showing a blank/white page. Every
  // renderPdfPage() call gets a generation number; only the most recent one
  // is allowed to touch the canvas or component state once its async work
  // (which includes network/CPU-bound getPage + render) completes. Any
  // in-flight PDF.js render task from a stale generation is also explicitly
  // cancelled rather than just ignored, so it stops consuming CPU/bandwidth
  // instead of racing silently in the background.
  private pdfGeneration: { left: number; right: number } = { left: 0, right: 0 };
  private pdfRenderTask: { left?: any; right?: any } = {};

  async renderPdfPage(pane: PaneState, index: number) {
    if (!pane.pdfDoc) return;
    const side: 'left' | 'right' = pane === this.left ? 'left' : 'right';

    // Cancel any render still in flight for this side before starting a new one.
    this.pdfRenderTask[side]?.cancel?.();

    const myGen = ++this.pdfGeneration[side];
    pane.pageRendering = true;

    let page: any;
    try {
      page = await pane.pdfDoc.getPage(index + 1);
    } catch (e: any) {
      if (myGen !== this.pdfGeneration[side]) return; // superseded
      pane.pageRendering = false;
      pane.error = `Failed to load page ${index + 1}: ` + (e?.message || 'unknown error');
      return;
    }
    if (myGen !== this.pdfGeneration[side]) return; // superseded while awaiting getPage

    const canvasId = this.pdfCanvasId(side, index);
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
      pane.pageRendering = false;
      pane.error = 'PDF canvas not found in the DOM.';
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      pane.pageRendering = false;
      pane.error = 'Could not get 2D canvas context to render the PDF.';
      return;
    }

    // Render at device pixel ratio so text/diagrams stay sharp even though
    // the canvas is then displayed scaled down (via CSS max-width: 100%).
    // pane.naturalSize is always recorded in *unscaled* (CSS) pixels — the
    // same pixel space pin coordinates are captured and stored in — so
    // pins line up regardless of DPR or however small the pane is shrunk.
    const dpr = window.devicePixelRatio || 1;
    const baseViewport = page.getViewport({ scale: 1.4 });
    const renderViewport = page.getViewport({ scale: 1.4 * dpr });

    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = `${baseViewport.width}px`;
    canvas.style.height = `${baseViewport.height}px`;

    const renderTask = page.render({ canvasContext: ctx, viewport: renderViewport });
    this.pdfRenderTask[side] = renderTask;

    try {
      await renderTask.promise;
    } catch (e: any) {
      if (myGen !== this.pdfGeneration[side]) return; // cancelled/superseded — expected, not an error
      pane.pageRendering = false;
      pane.error = `Failed to render page ${index + 1}: ` + (e?.message || 'unknown error');
      return;
    }
    if (myGen !== this.pdfGeneration[side]) return; // superseded while rendering — don't touch state

    pane.pageRendering = false;
    pane.activeIndex = index;
    pane.naturalSize = { width: baseViewport.width, height: baseViewport.height };
  }

  // ============================================================
  // PPTX
  // ============================================================

  private async loadPptxPane(pane: PaneState, filename: string | null, side: 'left' | 'right') {
    if (!filename) {
      pane.error = `No ${pane.docType === 'claude_ppt' ? 'Claude' : 'ChatGPT'} PPT attached yet.`;
      return;
    }
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext !== 'pptx') {
      pane.needsPptxOnly = true;
      pane.error = 'This file is a legacy .ppt and cannot be previewed. Please re-upload it as .pptx to compare.';
      return;
    }

    const url = `${this.API_BASE}/topics/${this.topicId}/slide-doc/${pane.docType}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e: any) {
      pane.error = 'Could not reach the server to download the PPT. Check your connection and try again.';
      return;
    }
    if (!res.ok) {
      if (res.status === 404) {
        pane.error = 'This PPT is missing on the server.';
      } else {
        pane.error = `Failed to download the PPT (HTTP ${res.status}).`;
      }
      return;
    }
    const bytes = await res.arrayBuffer();

    if (bytes.byteLength < 4 || !this.looksLikeZip(bytes)) {
      pane.error = 'The stored PPT file is corrupted (not a valid .pptx/zip). Please re-export and re-upload it.';
      return;
    }

    pane.pptxBytes = bytes;
    // Flip loading off NOW (same reasoning as the PDF path above) so
    // Angular mounts the *ngIf="!loading"-gated container. The actual
    // per-slide canvases only exist once pane.items is populated inside
    // initPptxViewer(), which waits for them itself.
    pane.loading = false;
    await this.initPptxViewer(pane, side);
  }

  /** Canvas id for a specific slide index within a side's vertical list (slide 0 keeps the original id so nothing else that references it breaks). */
  private pptxCanvasId(side: 'left' | 'right', index: number): string {
    const base = side === 'left' ? 'leftPptxCanvas' : 'rightPptxCanvas';
    return index === 0 ? base : `${base}-${index}`;
  }

  /** Checks the first bytes for the "PK" signature every zip (incl. .pptx) starts with. */
  private looksLikeZip(bytes: ArrayBuffer): boolean {
    const head = new Uint8Array(bytes.slice(0, 2));
    return head[0] === 0x50 && head[1] === 0x4b; // 'P' 'K'
  }

  /**
   * PptxViewJS instances, one per side. Unlike pptx-preview (which injects a
   * full DOM tree per slide and has no dedicated placeholder/slideLayout
   * inheritance handling), PptxViewJS renders each slide to a <canvas> via
   * renderSlide(index, canvas) and correctly resolves PowerPoint's
   * placeholder inheritance chain (slide -> slideLayout -> slideMaster ->
   * theme) — which matters because many real-world decks (including ones
   * exported by python-pptx-style tooling) define slide content entirely as
   * placeholders with no explicit geometry/fill of their own, relying on the
   * layout/master for everything. pptx-preview doesn't resolve that chain
   * and silently renders an empty slide (just its background fill).
   */
  private pptxViewer: { left?: any; right?: any } = {};

  private async initPptxViewer(pane: PaneState, side: 'left' | 'right') {
    if (!pane.pptxBytes) {
      pane.error = 'No presentation data loaded.';
      return;
    }
    const pptxBytes = pane.pptxBytes; // narrowed local — pane.pptxBytes stays ArrayBuffer | null on the interface

    // NOTE: pane.items is still [] at this point (it's only populated below,
    // once we know the slide count from the loaded file), so the template's
    // *ngFor over pane.items hasn't mounted ANY canvas yet — not even index
    // 0. PptxViewJS still needs *some* canvas to construct against, so we
    // hand it a detached off-DOM canvas just to load the file and read the
    // slide count; the real on-screen canvases (mounted once pane.items is
    // set) are what renderAllPptxSlides()/renderPptxSlide() actually draw
    // into afterwards.
    const bootstrapCanvas = document.createElement('canvas');

    pane.pageRendering = true;
    try {
      const { PPTXViewer } = await import('pptxviewjs');
      const viewer = new PPTXViewer({ canvas: bootstrapCanvas });
      this.pptxViewer[side] = viewer;

      await viewer.loadFile(pptxBytes);
      const slideCount = viewer.getSlideCount ? viewer.getSlideCount() : 1;

      // Read the deck's real slide dimensions (EMU) so every canvas is sized
      // to the SAME aspect ratio as the actual .pptx — forcing a fixed 16:9
      // box (the old behaviour) squeezes/stretches decks authored at 4:3 or
      // any custom size, which is what was throwing text and images out of
      // alignment compared to the original file. PptxViewJS exposes this as
      // presentation.slideSize.{cx,cy} after loadFile() resolves, even
      // though it isn't part of the public .d.ts.
      const slideSize = (viewer as any).presentation?.slideSize;
      pane.pptxAspectRatio = (slideSize && slideSize.cx && slideSize.cy)
        ? slideSize.cx / slideSize.cy
        : 16 / 9; // fallback only used if the library couldn't report a size at all

      pane.items = Array.from({ length: slideCount }, (_, i) => ({
        pageKey: `page-${i + 1}`,
        label: `Slide ${i + 1}`
      }));

      // Items are now set, so Angular will mount one canvas per slide on
      // its next change detection pass. Wait for the first one before
      // rendering anything.
      await this.waitForElement(this.pptxCanvasId(side, 0));

      // Render every slide into its own canvas, one after another, so the
      // pane can show the whole deck as a scrollable vertical list instead
      // of one slide at a time.
      await this.renderAllPptxSlides(pane, side);
    } catch (e: any) {
      pane.error = 'Failed to render the presentation: ' + (e?.message || 'unknown error');
      pane.pageRendering = false;
    }
  }

  /**
   * Loops renderPptxSlide() across every slide index, waiting for each
   * index's canvas to exist in the DOM first (Angular mounts them from the
   * *ngFor over pane.items, which was just populated above).
   */
  async renderAllPptxSlides(pane: PaneState, side: 'left' | 'right') {
    for (let i = 0; i < pane.items.length; i++) {
      await this.waitForElement(this.pptxCanvasId(side, i));
      const canvas = document.getElementById(this.pptxCanvasId(side, i)) as HTMLCanvasElement | null;
      if (canvas) this.sizePptxCanvas(canvas, pane.pptxAspectRatio ?? undefined);
      await this.renderPptxSlide(pane, i);
    }
  }

  /**
   * Gives the pptx canvas an explicit size before render, so PptxViewJS's
   * own internal layout math (which reads the canvas's pixel dimensions —
   * NOT its CSS display size) has the right numbers to work with. Uses the
   * DECK'S OWN aspect ratio (read from the .pptx file itself, see
   * initPptxViewer()) rather than assuming 16:9 — assuming a fixed ratio
   * squeezed/stretched every slide's content whenever the real deck was
   * 4:3 or any other size.
   *
   * FIX: this previously only set canvas.style.width/height (the CSS
   * display box). It never set canvas.width/canvas.height — the canvas's
   * actual drawing-buffer size, which is what PptxViewJS reads to compute
   * every shape/textbox's absolute position and scale on the slide. With
   * the buffer left at its default (or a stale size from a previous
   * render), PptxViewJS was laying out every element against the wrong
   * internal pixel space while the browser stretched the result to fit
   * our CSS box — producing exactly the misaligned/overlapping text boxes
   * and shifted chart labels seen on screen, even though the source .pptx
   * itself was fine. Now, both the drawing-buffer size (used by the
   * renderer, scaled by devicePixelRatio for crisp text) and the CSS
   * display size (used by the browser to fit the pane) are set explicitly,
   * matching the same dual-size pattern already used for PDF pages in
   * renderPdfPage().
   *
   * Measures off the pane's scrollable body (.cv-pane-body), NOT the
   * canvas's own immediate wrapper (.cv-surface-pptx) — that wrapper is a
   * flex item that shrink-wraps to its content, so before the canvas has
   * any size of its own, clientWidth on the wrapper is 0/unreliable. The
   * pane body's width is stable regardless of whether anything has
   * rendered inside it yet.
   */
  private sizePptxCanvas(canvas: HTMLCanvasElement, aspectRatio: number = 16 / 9) {
    const paneBody = canvas.closest('.cv-pane-body') as HTMLElement | null;
    const availableWidth = Math.max(320, (paneBody?.clientWidth || 900) - 48); // margin for padding
    const width = Math.min(1280, availableWidth);
    const height = Math.round(width / aspectRatio);

    // CSS display size — what the browser fits into the pane's layout.
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Drawing-buffer size — what PptxViewJS actually renders shapes/text
    // into. Scaled by devicePixelRatio so text stays sharp on hi-DPI
    // screens instead of looking blurry once the browser stretches a
    // low-res buffer up to the CSS box.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  // Same generation-token guard as renderPdfPage(), for the same reason:
  // quick Prev/Next clicks shouldn't let an older render finish after a
  // newer one and overwrite it, leaving the canvas showing the wrong slide
  // or a half-drawn frame.
  private pptxGeneration: { left: number; right: number } = { left: 0, right: 0 };

  async renderPptxSlide(pane: PaneState, index: number) {
    const side: 'left' | 'right' = pane === this.left ? 'left' : 'right';
    const viewer = this.pptxViewer[side];
    if (!viewer) return;

    const myGen = ++this.pptxGeneration[side];
    pane.pageRendering = true;

    const canvasId = this.pptxCanvasId(side, index);
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
      pane.pageRendering = false;
      pane.error = 'Presentation canvas not found in the DOM.';
      return;
    }

    try {
      if (viewer.renderSlide) {
        await viewer.renderSlide(index, canvas);
      } else {
        await viewer.goToSlide(index);
        await viewer.render(canvas);
      }
    } catch (e: any) {
      if (myGen !== this.pptxGeneration[side]) return; // superseded — expected, not an error
      pane.pageRendering = false;
      pane.error = `Failed to render slide ${index + 1}: ` + (e?.message || 'unknown error');
      return;
    }
    if (myGen !== this.pptxGeneration[side]) return; // superseded while rendering

    pane.pageRendering = false;
    pane.activeIndex = index;
    // Canvas natural size = its intrinsic pixel buffer size (canvas.width/
    // height attributes), same natural-space convention used for PDF pins.
    pane.naturalSize = { width: canvas.width, height: canvas.height };
  }

  // ============================================================
  // DOM READINESS HELPER
  // ============================================================

  /**
   * Waits (via requestAnimationFrame polling) until an element with the
   * given id exists in the DOM. Angular mounts pane content behind
   * *ngIf="!pane.loading", so it can take a render cycle after we flip
   * `loading = false` before the canvas/container actually exists — a bare
   * setTimeout(fn, 0) is not reliable here and can fire too early, causing
   * silent no-ops. Resolves immediately if the element already exists.
   */
  private waitForElement(id: string, maxFrames = 180): Promise<HTMLElement | null> {
    return new Promise(resolve => {
      const existing = document.getElementById(id);
      if (existing) { resolve(existing); return; }
      let attempts = 0;
      const poll = () => {
        const el = document.getElementById(id);
        if (el) { resolve(el); return; }
        attempts++;
        if (attempts >= maxFrames) { resolve(null); return; }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  }

  // ============================================================
  // NAVIGATION WITHIN A PANE
  // ============================================================

  goToItem(side: 'left' | 'right', index: number) {
    const pane = this.paneOf(side);
    if (index < 0 || index >= pane.items.length) return;

    if (pane.docType === 'claude_pdf') {
      // Don't flip activeIndex here — renderPdfPage() sets it only once the
      // new page has actually finished painting onto the canvas. Otherwise
      // the page counter/label jumps ahead while the canvas briefly shows
      // the previous (or a blank) page underneath it. Comments are loaded
      // only after render settles too, so "comments for this page" always
      // matches what's actually on screen, even if the user flips pages
      // faster than a render can complete.
      this.renderPdfPage(pane, index).then(() => this.loadCommentsFor(side));
    } else if (pane.docType === 'claude_ppt' || pane.docType === 'gpt_ppt') {
      // Same reasoning as the PDF branch: activeIndex updates only once the
      // slide has actually finished rendering to canvas.
      this.renderPptxSlide(pane, index).then(() => this.loadCommentsFor(side));
    } else {
      pane.activeIndex = index;
      this.loadCommentsFor(side);
    }
  }

  currentPageKey(side: 'left' | 'right'): string | null {
    const pane = this.paneOf(side);
    return pane.items[pane.activeIndex]?.pageKey ?? null;
  }

  // ============================================================
  // RESIZABLE SPLIT DIVIDER
  // ============================================================

  onDragStart = (event: MouseEvent) => {
    this.dragging = true;
    event.preventDefault();
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);
  };

  onDragMove = (event: MouseEvent) => {
    if (!this.dragging || !this.splitWrapRef) return;
    const rect = this.splitWrapRef.nativeElement.getBoundingClientRect();
    let pct = ((event.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(80, Math.max(20, pct));
    this.leftWidthPct = pct;
  };

  onDragEnd = () => {
    this.dragging = false;
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
  };

  // ============================================================
  // PANE ZOOM (visual scale only — independent of the render pipeline
  // and of natural-size pin math, which is unaffected by this).
  // ============================================================

  readonly ZOOM_MIN = 0.4;
  readonly ZOOM_MAX = 2.5;
  readonly ZOOM_STEP = 0.15;

  zoomIn(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    pane.zoom = Math.min(this.ZOOM_MAX, +(pane.zoom + this.ZOOM_STEP).toFixed(2));
  }

  zoomOut(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    pane.zoom = Math.max(this.ZOOM_MIN, +(pane.zoom - this.ZOOM_STEP).toFixed(2));
  }

  zoomReset(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    pane.zoom = 1;
  }

  // ============================================================
  // COMMENTS
  // ============================================================

  loadCommentsFor(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    if (!pane.docType || !this.topicId) return;

    this.loadingComments = true;
    this.api.get<any>(`/topics/${this.topicId}/comparison-comments?doc_type=${pane.docType}`).subscribe({
      next: (r: any) => {
        const others = this.comments.filter(c => c.doc_type !== pane.docType);
        this.comments = [...others, ...(r?.data || [])];
        this.loadingComments = false;
      },
      error: () => {
        this.loadingComments = false;
      }
    });
  }

  /**
   * All comments for the given side's document, across every page/slide —
   * not just the currently-active one — sorted in page/slide order, each
   * annotated with a human-readable page label for display in the comments
   * panel (e.g. "Slide 2", "Page 5"). Used to populate the comments panel
   * immediately with everything for the active tab, rather than only
   * whatever page happens to be "active".
   */
  allCommentsFor(side: 'left' | 'right'): (CommentPin & { pageLabel: string; pageIndex: number })[] {
    const pane = this.paneOf(side);
    if (!pane.docType) return [];
    const orderOf = new Map(pane.items.map((it, i) => [it.pageKey, i]));
    const labelOf = new Map(pane.items.map(it => [it.pageKey, it.label]));
    return this.comments
      .filter(c => c.doc_type === pane.docType)
      .map(c => ({
        ...c,
        pageLabel: labelOf.get(c.page_key) || c.page_key,
        pageIndex: orderOf.has(c.page_key) ? orderOf.get(c.page_key)! : 999999
      }))
      .sort((a, b) => a.pageIndex - b.pageIndex || (a.created_at > b.created_at ? 1 : -1));
  }

  /** Scrolls a given side's pane so the item at `index` is in view and opens its attached comment box — used when a comments-panel entry is clicked. */
  scrollToItem(side: 'left' | 'right', index: number) {
    const el = document.getElementById(side === 'left' ? `leftSurface-${index}` : `rightSurface-${index}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.openBox = { side, index };
  }

  commentsFor(side: 'left' | 'right'): CommentPin[] {
    const pane = this.paneOf(side);
    const pageKey = this.currentPageKey(side);
    if (!pane.docType || !pageKey) return [];
    return this.comments.filter(c => c.doc_type === pane.docType && c.page_key === pageKey);
  }

  /** Same as commentsFor(), but for a specific item index rather than the pane's activeIndex — used by the vertical scroll list where every slide/page is visible at once. */
  commentsForIndex(side: 'left' | 'right', index: number): CommentPin[] {
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey) return [];
    return this.comments.filter(c => c.doc_type === pane.docType && c.page_key === pageKey);
  }

  /**
   * Opens (or closes, if already open) the comment box attached to the
   * bottom edge of one specific page/slide/screenshot. Only one box is
   * open at a time across both panes — accordion-style — so there's never
   * ambiguity about which item a freshly-typed comment belongs to.
   */
  toggleCommentBox(side: 'left' | 'right', index: number) {
    if (this.isBoxOpen(side, index)) {
      this.closeCommentBox();
      return;
    }
    this.openBox = { side, index };
    this.newCommentText = '';
    this.editingCommentId = null;
    this.editingText = '';
    this.activePaneSide = side;
  }

  closeCommentBox() {
    this.openBox = null;
    this.newCommentText = '';
    this.editingCommentId = null;
    this.editingText = '';
  }

  isBoxOpen(side: 'left' | 'right', index: number): boolean {
    return !!this.openBox && this.openBox.side === side && this.openBox.index === index;
  }

  /** Human-readable noun for the compose placeholder — "page" / "slide" / "screenshot" — based on the side's doc type. */
  itemNoun(side: 'left' | 'right'): string {
    const dt = this.paneOf(side).docType;
    if (dt === 'claude_pdf') return 'page';
    if (dt === 'claude_ppt' || dt === 'gpt_ppt') return 'slide';
    return 'screenshot';
  }

  /** Maximizes one pane to fill the whole split view (hiding the other pane, the divider, and the comments panel) — or restores the normal split if that pane is already maximized. */
  toggleFullscreen(side: 'left' | 'right') {
    this.fullscreenSide = this.fullscreenSide === side ? null : side;
  }

  // ============================================================
  // PANE / COMMENTS PANEL VISIBILITY (three independent header toggles)
  // ============================================================

  /**
   * Toggles one of the three columns (left pane / right pane / comments
   * panel) on or off. Guards against ending up with nothing at all visible
   * — if closing this column would leave all three hidden, the toggle is
   * ignored rather than leaving a blank screen.
   */
  togglePaneVisibility(which: 'left' | 'right' | 'comments') {
    const nextLeft = which === 'left' ? !this.leftPaneOpen : this.leftPaneOpen;
    const nextRight = which === 'right' ? !this.rightPaneOpen : this.rightPaneOpen;
    const nextComments = which === 'comments' ? !this.commentsPanelOpen : this.commentsPanelOpen;

    if (!nextLeft && !nextRight && !nextComments) {
      this.toast.error("Can't close all three — at least one panel must stay open.");
      return;
    }

    this.leftPaneOpen = nextLeft;
    this.rightPaneOpen = nextRight;
    this.commentsPanelOpen = nextComments;
  }

  /** Effective width % for the left pane — expands to fill the row if the right pane is hidden. */
  get leftEffectiveWidth(): number {
    if (!this.rightPaneOpen) return 100;
    return this.leftWidthPct;
  }

  /** Effective width % for the right pane — expands to fill the row if the left pane is hidden. */
  get rightEffectiveWidth(): number {
    if (!this.leftPaneOpen) return 100;
    return 100 - this.leftWidthPct;
  }

  submitItemComment(side: 'left' | 'right', index: number) {
    const text = this.newCommentText.trim();
    if (!text || !this.topicId) return;
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey) return;

    const body: any = {
      doc_type: pane.docType,
      page_key: pageKey,
      text
    };

    this.api.post<any>(`/topics/${this.topicId}/comparison-comments`, body).subscribe({
      next: (r: any) => {
        if (r?.status && r?.data) {
          this.comments = [...this.comments, r.data];
          this.newCommentText = '';
        } else {
          this.toast.error(r?.message || 'Failed to add comment');
        }
      },
      error: () => this.toast.error('Failed to add comment')
    });
  }

  toggleResolve(comment: CommentPin) {
    const next = !comment.resolved;
    this.api.post<any>(`/comparison-comments/${comment.id}/resolve`, { resolved: next }).subscribe({
      next: (r: any) => {
        if (r?.status) comment.resolved = next;
      }
    });
  }

  /** Opens inline edit mode for a comment, directly inside its attached box. */
  startEditComment(comment: CommentPin) {
    this.editingCommentId = comment.id;
    this.editingText = comment.text;
  }

  cancelEditComment() {
    this.editingCommentId = null;
    this.editingText = '';
  }

  /**
   * Saves an inline edit. Requires a `POST /comparison-comments/{id}/update`
   * route on the backend (same pattern as the existing `/resolve` route) —
   * add it alongside that one if it doesn't exist yet.
   */
  saveEditComment(comment: CommentPin) {
    const text = this.editingText.trim();
    if (!text) return;
    this.api.post<any>(`/comparison-comments/${comment.id}/update`, { text }).subscribe({
      next: (r: any) => {
        if (r?.status) {
          comment.text = text;
          this.editingCommentId = null;
          this.editingText = '';
        } else {
          this.toast.error(r?.message || 'Failed to update comment');
        }
      },
      error: () => this.toast.error('Failed to update comment')
    });
  }

  deleteComment(comment: CommentPin) {
    if (!confirm('Delete this comment?')) return;
    this.api.delete<any>(`/comparison-comments/${comment.id}`).subscribe({
      next: (r: any) => {
        if (r?.status) {
          this.comments = this.comments.filter(c => c.id !== comment.id);
        } else {
          this.toast.error(r?.message || 'Failed to delete comment');
        }
      },
      error: () => this.toast.error('Failed to delete comment')
    });
  }

  // ============================================================
  // MARK FINAL / PENDING (per page, slide, or screenshot)
  // ============================================================

  private itemStatusKey(docType: CompareDocType, pageKey: string): string {
    return `${docType}::${pageKey}`;
  }

  /** Loads the mark-final status of every item for the given side's current doc type. */
  loadItemStatusesFor(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    if (!pane.docType || !this.topicId) return;

    this.api.get<any>(`/topics/${this.topicId}/item-status?doc_type=${pane.docType}`).subscribe({
      next: (r: any) => {
        const docType = pane.docType as CompareDocType;
        // Drop any previously-loaded statuses for this doc_type before
        // merging in the fresh set, same "replace this slice" pattern used
        // by loadCommentsFor() for the comments array.
        const kept: Record<string, ItemStatus> = {};
        for (const key of Object.keys(this.itemStatuses)) {
          if (!key.startsWith(`${docType}::`)) kept[key] = this.itemStatuses[key];
        }
        for (const status of (r?.data || []) as ItemStatus[]) {
          kept[this.itemStatusKey(status.doc_type, status.page_key)] = status;
        }
        this.itemStatuses = kept;
      },
      error: () => { /* non-fatal — items just show as "not marked" */ }
    });
  }

  /** Current mark-final status for a specific item, or undefined if it has never been marked either way. */
  statusFor(side: 'left' | 'right', index: number): ItemStatus | undefined {
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey) return undefined;
    return this.itemStatuses[this.itemStatusKey(pane.docType, pageKey)];
  }

  isFinal(side: 'left' | 'right', index: number): boolean {
    return !!this.statusFor(side, index)?.is_final;
  }

  /** Flips a page/slide/screenshot between "final" and "pending", recording who did it. */
  toggleFinal(side: 'left' | 'right', index: number) {
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey || !this.topicId) return;
    const docType = pane.docType;

    this.api.post<any>(`/topics/${this.topicId}/item-status/toggle`, {
      doc_type: docType,
      page_key: pageKey
    }).subscribe({
      next: (r: any) => {
        if (r?.status && r?.data) {
          this.itemStatuses = {
            ...this.itemStatuses,
            [this.itemStatusKey(docType, pageKey)]: r.data
          };
        } else {
          this.toast.error(r?.message || 'Failed to update status');
        }
      },
      error: () => this.toast.error('Failed to update status')
    });
  }
}