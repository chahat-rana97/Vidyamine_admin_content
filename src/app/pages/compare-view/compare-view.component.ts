import { Component, OnInit, OnDestroy, AfterViewInit, ElementRef, ViewChild, HostListener, Directive, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import * as pdfjsLib from 'pdfjs-dist';
import { jsPDF } from 'jspdf';
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

/**
 * Watches an element that uses native CSS `resize: both` (the sticky
 * notes) and emits its pixel size whenever the user finishes dragging the
 * resize handle. Needed because the browser's native resize has no Angular
 * event of its own — without this, a note's width/height only ever lives
 * in the DOM and is lost on refresh (only x/y position was ever persisted).
 * Debounces so we don't fire an API call on every intermediate pixel while
 * the user is still dragging — only ~300ms after they let go.
 */
@Directive({ selector: '[cvResizeWatch]', standalone: true })
export class StickyResizeWatchDirective implements AfterViewInit, OnDestroy {
  @Output() cvResized = new EventEmitter<{ width: number; height: number }>();

  private ro: ResizeObserver | null = null;
  private debounceHandle: any = null;
  private lastEmitted: { width: number; height: number } | null = null;
  private sawFirst = false;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    this.ro = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);

      // The observer fires immediately on attach with the element's
      // current (already-applied) size — skip that first callback so we
      // don't "save" a size the user never actually changed.
      if (!this.sawFirst) {
        this.sawFirst = true;
        this.lastEmitted = { width, height };
        return;
      }
      if (this.lastEmitted && this.lastEmitted.width === width && this.lastEmitted.height === height) return;

      clearTimeout(this.debounceHandle);
      this.debounceHandle = setTimeout(() => {
        this.lastEmitted = { width, height };
        this.cvResized.emit({ width, height });
      }, 300);
    });
    this.ro.observe(this.el.nativeElement);
  }

  ngOnDestroy(): void {
    clearTimeout(this.debounceHandle);
    this.ro?.disconnect();
  }
}

/** The four kinds of "document" that can appear in either pane. */
export type CompareDocType = 'screenshots' | 'claude_ppt' | 'gpt_ppt' | 'claude_pdf';

export const COMPARE_DOC_LABEL: Record<CompareDocType, string> = {
  screenshots: 'Screenshots',
  claude_ppt: 'Claude PPT',
  gpt_ppt: 'ChatGPT PPT',
  claude_pdf: 'Claude PDF'
};

/** Version slot for a doc type — null/undefined = the Original upload.
 *  Not applicable to 'screenshots'. Keep in sync with the backend's
 *  slideDocVersions() and the Topics screen's SLIDE_DOC_VERSIONS. */
export type CompareVersion = 'v1' | 'v2' | 'v3' | 'v4' | 'v5';
export const COMPARE_VERSIONS: CompareVersion[] = ['v1', 'v2', 'v3', 'v4', 'v5'];
export const COMPARE_VERSION_LABEL: Record<CompareVersion, string> = {
  v1: 'Version 1', v2: 'Version 2', v3: 'Version 3', v4: 'Version 4', v5: 'Version 5'
};

/**
 * Sticky-note color presets shown as small swatch circles in the edit UI.
 * Each preset is a [box base color (hex, opacity applied separately),
 * text color (hex)] pair chosen so the text stays readable against the
 * box in both light and dark app themes.
 */
export const STICKY_COLOR_PRESETS: { name: string; box: string; text: string }[] = [
  { name: 'Amber',   box: '#f59e0b', text: '#1f2430' },
  { name: 'Rose',    box: '#f43f5e', text: '#1f2430' },
  { name: 'Emerald', box: '#22c55e', text: '#1f2430' },
  { name: 'Sky',     box: '#38bdf8', text: '#1f2430' },
  { name: 'Violet',  box: '#8b5cf6', text: '#ffffff' },
  { name: 'Slate',   box: '#64748b', text: '#ffffff' }
];

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
  /** null/undefined = comment belongs to the Original slot. */
  version?: CompareVersion | null;
  page_key: string;
  /** Pin position as a 0–100 percentage of the item's own rendered width/height. Null/undefined = a plain footer comment (not pinned anywhere on the page). */
  x?: number | string | null;
  y?: number | string | null;
  text: string;
  /** CSS color (rgba, so it also carries opacity) for the sticky note's background. Null = frontend default. */
  box_color?: string | null;
  /** CSS color (hex) for the sticky note's text. Null = frontend default. */
  text_color?: string | null;
  /** Persisted pixel size of the resizable sticky note (from CSS `resize: both`). Null = never resized, use the CSS default. */
  width_px?: number | null;
  height_px?: number | null;
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
  /** null/undefined = status belongs to the Original slot. */
  version?: CompareVersion | null;
  page_key: string;
  is_final: boolean | number;
  marked_by: string | null;
  updated_at?: string;
}

/** Runtime state for one side (left or right) of the split view. */
interface PaneState {
  docType: CompareDocType | null;
  /** null/undefined = Original slot. Ignored when docType === 'screenshots'. */
  version: CompareVersion | null;
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
  imports: [CommonModule, FormsModule, StickyResizeWatchDirective],
  templateUrl: './compare-view.component.html',
  styleUrls: ['./compare-view.component.css']
})
export class CompareViewComponent implements OnInit, OnDestroy, AfterViewInit {

  // All document bytes are streamed through the API (same-origin), never
  // fetched directly from the static topic_attachments/Screenshots folders.
  // Screenshots are the one exception: they're rendered via plain <img src>,
  // which doesn't invoke CORS at all, so the static URL is fine there.
  readonly SCREENSHOT_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/Screenshots';
  readonly API_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm';

  readonly DOC_LABEL = COMPARE_DOC_LABEL;
  readonly STICKY_PRESETS = STICKY_COLOR_PRESETS;
  /** Fallback box color (hex) used when a sticky note has no box_color saved yet, and as the starting point when opening the color editor for the first time on a note. */
  readonly DEFAULT_STICKY_BOX_HEX = '#f59e0b';
  readonly DEFAULT_STICKY_TEXT_HEX = '#1f2430';
  readonly DEFAULT_STICKY_OPACITY = 0.18;

  topicId: number | null = null;
  topic: any = null;
  loadingTopic = false;

  pickerOpen = true;
  pickerLeft: CompareDocType | null = null;
  pickerRight: CompareDocType | null = null;
  /** Version sub-selection, shown once a doc type (other than screenshots) is chosen. null = Original. */
  pickerLeftVersion: CompareVersion | null = null;
  pickerRightVersion: CompareVersion | null = null;

  left: PaneState = this.emptyPane();
  right: PaneState = this.emptyPane();

  @ViewChild('splitWrap') splitWrapRef!: ElementRef<HTMLDivElement>;
  @ViewChild('leftPaneBody') leftPaneBodyRef!: ElementRef<HTMLDivElement>;
  @ViewChild('rightPaneBody') rightPaneBodyRef!: ElementRef<HTMLDivElement>;
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

  // ============================================================
  // STICKY-NOTE PIN COMMENTS ("+ Add comment" click-to-place mode)
  // ============================================================

  /** Which single page/slide/screenshot currently has "+ Add comment" pin-placement mode armed (crosshair cursor). Only one item at a time, accordion-style like openBox. */
  pinModeItem: { side: 'left' | 'right'; index: number } | null = null;

  /** A brand-new sticky note being composed, positioned but not yet saved. Null when nothing is being placed. */
  draftPin: { side: 'left' | 'right'; index: number; x: number; y: number; text: string; boxHex: string; textHex: string; opacity: number } | null = null;

  /** id of the pinned sticky-note comment currently open for editing, if any (separate from editingCommentId, which is for the footer box). */
  editingPinId: number | null = null;
  editingPinText = '';
  /** Working color state while a sticky note's editor is open — a preset swatch or the box's custom hex/opacity picker writes here, then saveEditPin()/saveDraftPin() combine boxHex+opacity into the rgba string that actually gets persisted as box_color. */
  editingPinBoxHex = this.DEFAULT_STICKY_BOX_HEX;
  editingPinTextHex = this.DEFAULT_STICKY_TEXT_HEX;
  editingPinOpacity = this.DEFAULT_STICKY_OPACITY;
  /** Whether the color/opacity picker row is expanded in the current sticky note editor. */
  showColorPicker = false;

  /** Which sticky note currently has its action-toolbar expanded.
   *  null = none expanded. 'draft' = the in-progress draft note.
   *  A pin id (number) = that saved note's toolbar is expanded.
   *  Clicking the small round color icon attached to a note toggles it. */
  expandedToolbarFor: number | 'draft' | null = null;

  toggleStickyActions(key: number | 'draft', evt?: Event) {
    evt?.stopPropagation();
    if (this.expandedToolbarFor === key) {
      this.expandedToolbarFor = null;
      this.showColorPicker = false;
    } else {
      this.expandedToolbarFor = key;
    }
  }

  isToolbarExpanded(key: number | 'draft'): boolean {
    return this.expandedToolbarFor === key;
  }

  /** Comment id currently being dragged to a new position, if any. */
  private draggingPinId: number | null = null;
  private dragPinMoved = false;

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

  /** When on, scrolling either pane scrolls the other to the matching
   *  item, proportionally mapped by index so panes with different item
   *  counts (e.g. a 4-page PPT vs a 5-page PDF) still track sensibly —
   *  once the shorter pane reaches its last item it just holds there
   *  while the longer one keeps scrolling. Off by default. */
  syncScrollEnabled = false;
  // Set to the side that's driving a sync-triggered scroll, so that
  // pane's own (scroll) handler doesn't immediately re-trigger a sync
  // back (which would fight the browser's smooth-scroll animation).
  private syncScrollSuppressSide: 'left' | 'right' | null = null;
  private syncScrollSuppressTimer: any = null;

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
      docType: null, version: null, loading: false, error: '', items: [], activeIndex: 0,
      pdfDoc: null, pptxBytes: null, needsPptxOnly: false,
      naturalSize: null, pageRendering: false, zoom: 1, pptxAspectRatio: null
    };
  }

  ngOnInit() {
    const idParam = this.route.snapshot.queryParamMap.get('topic_id');
    this.topicId = idParam ? Number(idParam) : null;

    const leftParam = this.route.snapshot.queryParamMap.get('left') as CompareDocType | null;
    const rightParam = this.route.snapshot.queryParamMap.get('right') as CompareDocType | null;
    const leftVersionParam = this.route.snapshot.queryParamMap.get('leftVersion') as CompareVersion | null;
    const rightVersionParam = this.route.snapshot.queryParamMap.get('rightVersion') as CompareVersion | null;

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
      this.pickerLeftVersion = leftVersionParam || null;
      this.pickerRightVersion = rightVersionParam || null;
      this.loadTopic(() => this.confirmPicker());
    } else {
      this.loadTopic();
    }
  }

  ngOnDestroy() {
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
    if (this.syncScrollSuppressTimer) clearTimeout(this.syncScrollSuppressTimer);
  }

  ngAfterViewInit() {
    // Pane-body scroll listeners are bound declaratively in the template
    // via (scroll)="onPaneScroll(side)" — nothing to wire up manually here.
  }

  /** Closes the download menu when the user clicks anywhere else in the document. The menu root calls $event.stopPropagation() so clicks inside it don't trigger this. */
  @HostListener('document:click')
  onDocumentClick() {
    this.downloadMenuOpen = false;
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
    // A doc type is offered if ANY slot (original or v1..v5) has a file —
    // the version sub-picker narrows down to the specific slot afterward.
    if (this.anySlotFilled('claude_ppt')) out.push('claude_ppt');
    if (this.anySlotFilled('gpt_ppt')) out.push('gpt_ppt');
    if (this.anySlotFilled('claude_pdf')) out.push('claude_pdf');
    return out;
  }

  private slotFieldFor(docType: CompareDocType, version: CompareVersion | null): string | null {
    const base: Record<string, string> = {
      claude_ppt: 'slide_claude_ppt', gpt_ppt: 'slide_gpt_ppt', claude_pdf: 'slide_claude_pdf'
    };
    const field = base[docType];
    if (!field) return null; // 'screenshots' has no slot field
    return version ? `${field}_${version}` : field;
  }

  private anySlotFilled(docType: CompareDocType): boolean {
    if (!this.topic) return false;
    const original = this.slotFieldFor(docType, null);
    if (original && this.topic[original]) return true;
    return COMPARE_VERSIONS.some(v => {
      const f = this.slotFieldFor(docType, v);
      return f && !!this.topic[f];
    });
  }

  /** Which slots (Original + v1..v5) actually have a file for this doc type — drives the version sub-picker. */
  availableVersionsFor(docType: CompareDocType | null): (CompareVersion | null)[] {
    if (!docType || docType === 'screenshots' || !this.topic) return [];
    const out: (CompareVersion | null)[] = [];
    const original = this.slotFieldFor(docType, null);
    if (original && this.topic[original]) out.push(null);
    for (const v of COMPARE_VERSIONS) {
      const f = this.slotFieldFor(docType, v);
      if (f && this.topic[f]) out.push(v);
    }
    return out;
  }

  versionLabel(version: CompareVersion | null): string {
    return version ? COMPARE_VERSION_LABEL[version] : 'Original';
  }

  /**
   * Comments and item-status are keyed by a plain `doc_type` string on the
   * backend (no DB migration for those tables). To keep Original vs v1..v5
   * annotations independent without touching that schema, we encode the
   * version into the string sent/read for those two endpoints only:
   * 'claude_ppt' (Original) vs 'claude_ppt::v1' .. '::v5'.
   * The Slide-doc file endpoints are unaffected — they use pane.docType +
   * pane.version separately via a real `version` query param.
   */
  private composeDocTypeKey(docType: CompareDocType | null, version: CompareVersion | null | undefined): string {
    if (!docType) return '';
    return version ? `${docType}::${version}` : docType;
  }

  private paneDocTypeKey(pane: PaneState): string {
    return this.composeDocTypeKey(pane.docType, pane.version);
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

  /** Step 1: choose the doc type for a side. Resets that side's version to the first available slot. */
  choosePickerSide(side: 'left' | 'right', docType: CompareDocType) {
    const versions = this.availableVersionsFor(docType);
    const defaultVersion = versions.length ? versions[0] : null;
    if (side === 'left') {
      this.pickerLeft = docType;
      this.pickerLeftVersion = defaultVersion;
    } else {
      this.pickerRight = docType;
      this.pickerRightVersion = defaultVersion;
    }
  }

  /** Step 2 (only for non-screenshot doc types with more than one slot): choose which version/slot. */
  choosePickerVersion(side: 'left' | 'right', version: CompareVersion | null) {
    if (side === 'left') this.pickerLeftVersion = version;
    else this.pickerRightVersion = version;
  }

  get pickerValid(): boolean {
    if (!this.pickerLeft || !this.pickerRight) return false;
    // Same doc type is allowed now IF the versions differ (e.g. Claude PPT v1 vs Claude PPT v2).
    if (this.pickerLeft === this.pickerRight) {
      return this.pickerLeftVersion !== this.pickerRightVersion;
    }
    return true;
  }

  confirmPicker() {
    if (!this.pickerValid) return;
    this.pickerOpen = false;
    this.left = this.emptyPane();
    this.right = this.emptyPane();
    this.left.docType = this.pickerLeft;
    this.left.version = this.pickerLeft === 'screenshots' ? null : this.pickerLeftVersion;
    this.right.docType = this.pickerRight;
    this.right.version = this.pickerRight === 'screenshots' ? null : this.pickerRightVersion;
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
        const field = this.slotFieldFor('claude_pdf', pane.version);
        await this.loadPdfPane(pane, field ? this.topic[field] : null, side);
      } else if (pane.docType === 'claude_ppt' || pane.docType === 'gpt_ppt') {
        const field = this.slotFieldFor(pane.docType, pane.version);
        const filename = field ? this.topic[field] : null;
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
    if (!filename) { pane.error = `No Claude PDF (${this.versionLabel(pane.version)}) attached yet.`; return; }

    const url = `${this.API_BASE}/topics/${this.topicId}/slide-doc/claude_pdf` +
      (pane.version ? `?version=${pane.version}` : '');

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
      pane.error = `No ${pane.docType === 'claude_ppt' ? 'Claude' : 'ChatGPT'} PPT (${this.versionLabel(pane.version)}) attached yet.`;
      return;
    }
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (ext !== 'pptx') {
      pane.needsPptxOnly = true;
      pane.error = 'This file is a legacy .ppt and cannot be previewed. Please re-upload it as .pptx to compare.';
      return;
    }

    const url = `${this.API_BASE}/topics/${this.topicId}/slide-doc/${pane.docType}` +
      (pane.version ? `?version=${pane.version}` : '');
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

    const key = this.paneDocTypeKey(pane);
    this.loadingComments = true;
    this.api.get<any>(`/topics/${this.topicId}/comparison-comments?doc_type=${key}`).subscribe({
      next: (r: any) => {
        const others = this.comments.filter(c => (c.doc_type as any) !== key);
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
    const key = this.paneDocTypeKey(pane);
    const orderOf = new Map(pane.items.map((it, i) => [it.pageKey, i]));
    const labelOf = new Map(pane.items.map(it => [it.pageKey, it.label]));
    return this.comments
      .filter(c => (c.doc_type as any) === key)
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

  // ============================================================
  // SYNCED SCROLLING BETWEEN PANES
  // ============================================================

  /** The Sync button is disabled for now — clicking it just tells the user
   * it's coming rather than actually toggling sync (toggleSyncScroll()
   * below is kept as-is, just not wired to the button, so it's a one-line
   * change to re-enable later). */
  onSyncButtonClick() {
    this.toast.error('This feature is in progress');
  }

  toggleSyncScroll() {
    this.syncScrollEnabled = !this.syncScrollEnabled;
    if (this.syncScrollEnabled) {
      // Snap the two panes into alignment right away, using whichever
      // side currently has more items scrolled as the driver, so turning
      // sync on doesn't wait for the next manual scroll to take effect.
      this.syncPanes('left');
    }
  }

  /** Finds the index of the item currently nearest the top of a pane's scrollable body, by comparing each .cv-vitem's offsetTop against the body's scrollTop. Falls back to 0 if the pane isn't rendered yet. */
  private currentTopIndex(side: 'left' | 'right'): number {
    const bodyEl = side === 'left' ? this.leftPaneBodyRef?.nativeElement : this.rightPaneBodyRef?.nativeElement;
    if (!bodyEl) return 0;
    const items = bodyEl.querySelectorAll('.cv-vitem');
    if (!items.length) return 0;

    const bodyTop = bodyEl.scrollTop;
    let best = 0;
    let bestDelta = Infinity;
    items.forEach((el, i) => {
      const itemEl = el as HTMLElement;
      const delta = Math.abs(itemEl.offsetTop - bodyTop);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    return best;
  }

  /** Scrolls a pane so the item at `index` sits at the top of its scrollable body (no smooth animation during live sync-drag, to stay responsive). */
  private scrollPaneToIndex(side: 'left' | 'right', index: number) {
    const bodyEl = side === 'left' ? this.leftPaneBodyRef?.nativeElement : this.rightPaneBodyRef?.nativeElement;
    if (!bodyEl) return;
    const items = bodyEl.querySelectorAll('.cv-vitem');
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    const targetEl = items[clamped] as HTMLElement | undefined;
    if (!targetEl) return;

    // Briefly suppress this side's own scroll handler so the programmatic
    // scroll we're about to do doesn't immediately re-trigger another sync
    // pass (which would otherwise ping-pong between the two panes).
    this.syncScrollSuppressSide = side;
    if (this.syncScrollSuppressTimer) clearTimeout(this.syncScrollSuppressTimer);
    this.syncScrollSuppressTimer = setTimeout(() => { this.syncScrollSuppressSide = null; }, 150);

    bodyEl.scrollTop = targetEl.offsetTop;
  }

  /** Core sync: reads the driving side's current item index, maps it proportionally onto the other side's item count (so a 4-item pane and a 5-item pane still track together, holding at the last item once the shorter one runs out), and scrolls the other pane to match. */
  private syncPanes(drivingSide: 'left' | 'right') {
    if (!this.syncScrollEnabled) return;
    const otherSide = drivingSide === 'left' ? 'right' : 'left';
    const drivingPane = this.paneOf(drivingSide);
    const otherPane = this.paneOf(otherSide);
    const drivingCount = drivingPane.items.length;
    const otherCount = otherPane.items.length;
    if (!drivingCount || !otherCount) return;

    const drivingIndex = this.currentTopIndex(drivingSide);
    // Proportional mapping: position 0..(drivingCount-1) maps onto
    // 0..(otherCount-1). When counts are equal this is just a 1:1 match.
    const ratio = drivingCount > 1 ? drivingIndex / (drivingCount - 1) : 0;
    const otherIndex = Math.round(ratio * (otherCount - 1));

    this.scrollPaneToIndex(otherSide, otherIndex);
  }

  private syncScrollRafPending = false;

  /** Bound to (scroll) on both .cv-pane-body elements. Only acts while sync is on, and skips the pass that was itself just caused by a sync-triggered scroll on this same side. Throttled to one sync pass per animation frame so fast/trackpad scrolling doesn't flood recomputation. */
  onPaneScroll(side: 'left' | 'right') {
    if (!this.syncScrollEnabled) return;
    if (this.syncScrollSuppressSide === side) return;
    if (this.syncScrollRafPending) return;
    this.syncScrollRafPending = true;
    requestAnimationFrame(() => {
      this.syncScrollRafPending = false;
      this.syncPanes(side);
    });
  }

  commentsFor(side: 'left' | 'right'): CommentPin[] {
    const pane = this.paneOf(side);
    const pageKey = this.currentPageKey(side);
    if (!pane.docType || !pageKey) return [];
    const key = this.paneDocTypeKey(pane);
    return this.comments.filter(c => (c.doc_type as any) === key && c.page_key === pageKey);
  }

  /** Same as commentsFor(), but for a specific item index rather than the pane's activeIndex — used by the vertical scroll list where every slide/page is visible at once. Returns EVERY comment on the item (both plain footer comments and pinned sticky notes) — use footerCommentsForIndex()/pinnedCommentsForIndex() to split them apart. */
  commentsForIndex(side: 'left' | 'right', index: number): CommentPin[] {
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey) return [];
    const key = this.paneDocTypeKey(pane);
    return this.comments.filter(c => (c.doc_type as any) === key && c.page_key === pageKey);
  }

  /** True if a CommentPin has a real x/y pin position (a sticky note), vs a plain footer comment. */
  private hasPin(c: CommentPin): boolean {
    return c.x !== null && c.x !== undefined && (c.x as any) !== '' &&
           c.y !== null && c.y !== undefined && (c.y as any) !== '';
  }

  /** Only the plain (unpositioned) comments for an item — shown in the footer "Comment" box. */
  footerCommentsForIndex(side: 'left' | 'right', index: number): CommentPin[] {
    return this.commentsForIndex(side, index).filter(c => !this.hasPin(c));
  }

  /** Only the pinned sticky-note comments for an item — rendered as floating notes on top of the page/slide/screenshot. */
  pinnedCommentsForIndex(side: 'left' | 'right', index: number): CommentPin[] {
    return this.commentsForIndex(side, index).filter(c => this.hasPin(c));
  }

  /** Numeric x%/y% helpers for template style bindings (x/y may come back from the API as strings). */
  pinX(c: CommentPin): number { return typeof c.x === 'string' ? parseFloat(c.x) : (c.x as number) || 0; }
  pinY(c: CommentPin): number { return typeof c.y === 'string' ? parseFloat(c.y) : (c.y as number) || 0; }

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

    // The compose box (or the comment list, if long) can end up below the
    // visible part of the scrollable pane — scroll it into view so the
    // "write a comment" field is never hidden below the fold.
    requestAnimationFrame(() => {
      const el = document.getElementById(side === 'left' ? `leftSurface-${index}` : `rightSurface-${index}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  closeCommentBox() {
    this.openBox = null;
    this.newCommentText = '';
    this.editingCommentId = null;
    this.editingText = '';
  }

  // ============================================================
  // STICKY-NOTE PIN COMMENTS
  // ============================================================

  /** True while pin-placement mode is armed for this specific item (crosshair cursor, click anywhere on the page to drop a sticky note). */
  isPinModeActive(side: 'left' | 'right', index: number): boolean {
    return !!this.pinModeItem && this.pinModeItem.side === side && this.pinModeItem.index === index;
  }

  /** Toggles "+ Add comment" pin-placement mode for one item. Arming it on one item disarms it everywhere else and cancels any in-progress draft note. */
  togglePinMode(side: 'left' | 'right', index: number, evt?: Event) {
    evt?.stopPropagation();
    if (!this.canWrite) return;
    if (this.isPinModeActive(side, index)) {
      this.pinModeItem = null;
      this.draftPin = null;
      return;
    }
    this.pinModeItem = { side, index };
    this.draftPin = null;
  }

  private exitPinMode() {
    this.pinModeItem = null;
    this.draftPin = null;
  }

  /**
   * Handles a click anywhere on a page/slide/screenshot surface. If pin
   * mode is armed for this exact item, drops a new draft sticky note at
   * the clicked spot (as a 0–100% position relative to the surface's own
   * rendered box, so it lines up correctly regardless of zoom level).
   * Ignored otherwise so normal clicks on the page do nothing.
   */
  onSurfaceClick(side: 'left' | 'right', index: number, evt: MouseEvent) {
    if (!this.isPinModeActive(side, index)) return;
    const target = evt.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const xPct = Math.min(100, Math.max(0, ((evt.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.min(100, Math.max(0, ((evt.clientY - rect.top) / rect.height) * 100));

    this.draftPin = {
      side, index, x: xPct, y: yPct, text: '',
      boxHex: this.DEFAULT_STICKY_BOX_HEX,
      textHex: this.DEFAULT_STICKY_TEXT_HEX,
      opacity: this.DEFAULT_STICKY_OPACITY
    };
    this.showColorPicker = false;
    // Expand the toolbar by default for a brand-new draft note so Save/
    // Cancel are visible right away, without an extra click on the icon.
    this.expandedToolbarFor = 'draft';
    // Pin mode stays armed until the draft is saved/cancelled so the user
    // sees exactly where the note will land before committing.
  }

  cancelDraftPin() {
    this.draftPin = null;
    this.showColorPicker = false;
    this.expandedToolbarFor = null;
    this.exitPinMode();
  }

  /** Applies a preset swatch to the note currently being composed (draft) or edited (existing pin). */
  applyPresetToDraft(preset: { box: string; text: string }) {
    if (!this.draftPin) return;
    this.draftPin.boxHex = preset.box;
    this.draftPin.textHex = preset.text;
  }
  applyPresetToEditing(preset: { box: string; text: string }) {
    this.editingPinBoxHex = preset.box;
    this.editingPinTextHex = preset.text;
  }

  toggleColorPicker(evt?: Event) {
    evt?.stopPropagation();
    this.showColorPicker = !this.showColorPicker;
  }

  /** Saves the in-progress draft sticky note as a real pinned comment, including its chosen color + opacity. */
  saveDraftPin() {
    if (!this.draftPin || !this.topicId) return;
    const text = this.draftPin.text.trim();
    if (!text) return;

    const { side, index, x, y, boxHex, textHex, opacity } = this.draftPin;
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey) return;

    const body: any = {
      doc_type: this.paneDocTypeKey(pane),
      page_key: pageKey,
      text, x, y,
      box_color: this.hexToRgba(boxHex, opacity),
      text_color: textHex
    };

    this.api.post<any>(`/topics/${this.topicId}/comparison-comments`, body).subscribe({
      next: (r: any) => {
        if (r?.status && r?.data) {
          this.comments = [...this.comments, r.data];
          this.draftPin = null;
          this.showColorPicker = false;
          this.expandedToolbarFor = null;
          this.exitPinMode();
        } else {
          this.toast.error(r?.message || 'Failed to add comment');
        }
      },
      error: () => this.toast.error('Failed to add comment')
    });
  }

  /** Opens inline edit mode on a pinned sticky note (separate edit state from the footer box's editingCommentId, so both kinds can't collide). Seeds the color picker from the note's saved box_color/text_color, falling back to defaults if it was never customized. */
  startEditPin(c: CommentPin, evt?: Event) {
    evt?.stopPropagation();
    this.editingPinId = c.id;
    this.editingPinText = c.text;
    const parsed = this.rgbaToHexOpacity(c.box_color) || { hex: this.DEFAULT_STICKY_BOX_HEX, opacity: this.DEFAULT_STICKY_OPACITY };
    this.editingPinBoxHex = parsed.hex;
    this.editingPinOpacity = parsed.opacity;
    this.editingPinTextHex = c.text_color || this.DEFAULT_STICKY_TEXT_HEX;
    this.showColorPicker = false;
    // Keep the toolbar expanded (it was open — that's how Edit got clicked)
    // so the Colors/Cancel/Save row stays visible right after entering edit mode.
    this.expandedToolbarFor = c.id;
  }

  cancelEditPin(evt?: Event) {
    evt?.stopPropagation();
    this.editingPinId = null;
    this.editingPinText = '';
    this.showColorPicker = false;
    this.expandedToolbarFor = null;
  }

  saveEditPin(c: CommentPin, evt?: Event) {
    evt?.stopPropagation();
    const text = this.editingPinText.trim();
    if (!text) return;
    const box_color = this.hexToRgba(this.editingPinBoxHex, this.editingPinOpacity);
    const text_color = this.editingPinTextHex;
    this.api.post<any>(`/comparison-comments/${c.id}/update`, { text, box_color, text_color }).subscribe({
      next: (r: any) => {
        if (r?.status) {
          c.text = text;
          c.box_color = box_color;
          c.text_color = text_color;
          this.editingPinId = null;
          this.showColorPicker = false;
          this.expandedToolbarFor = null;
        } else {
          this.toast.error(r?.message || 'Failed to update comment');
        }
      },
      error: () => this.toast.error('Failed to update comment')
    });
  }

  toggleResolvePin(c: CommentPin, evt?: Event) {
    evt?.stopPropagation();
    this.toggleResolve(c);
  }

  deletePin(c: CommentPin, evt?: Event) {
    evt?.stopPropagation();
    this.deleteComment(c);
  }

  /** Starts dragging an existing sticky note to a new spot on its surface. */
  onPinDragStart(c: CommentPin, evt: MouseEvent) {
    if (!this.canWrite) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.draggingPinId = c.id;
    this.dragPinMoved = false;

    const surface = (evt.currentTarget as HTMLElement).closest('.cv-surface') as HTMLElement | null;
    if (!surface) return;

    const onMove = (moveEvt: MouseEvent) => {
      const rect = surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.dragPinMoved = true;
      const xPct = Math.min(100, Math.max(0, ((moveEvt.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(100, Math.max(0, ((moveEvt.clientY - rect.top) / rect.height) * 100));
      c.x = xPct;
      c.y = yPct;
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this.draggingPinId = null;
      if (this.dragPinMoved) {
        this.api.post<any>(`/comparison-comments/${c.id}/position`, { x: c.x, y: c.y }).subscribe({
          error: () => this.toast.error('Failed to save new position')
        });
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ============================================================
  // STICKY-NOTE COLOR HELPERS
  // ============================================================

  /** Converts a "#rrggbb" hex color + 0–1 opacity into an "rgba(r,g,b,a)" string for storage in box_color. */
  // ============================================================
  // PDF BRANDING (VidyaMine header/logo, shared by both PDF exports)
  // ============================================================

  /** VidyaMine brand blue, sampled from the logo (public/assets/vm_logo.png). */
  private readonly BRAND = { r: 0, g: 112, b: 158 };
  private readonly BRAND_DARK = { r: 0, g: 76, b: 107 };

  // Cached logo data URL so repeat PDF exports in the same session don't
  // re-fetch it. null = not yet loaded, undefined = load failed/skip.
  private logoDataUrl: string | null | undefined;

  /** Fetches public/assets/vm_logo.png once and caches it as a data URL for embedding in jsPDF (addImage needs a data URL, not a plain <img> src). Resolves to undefined (not thrown) if it can't be loaded, so a missing/renamed logo file never breaks the PDF export — the header just falls back to text-only. */
  private async loadLogoDataUrl(): Promise<string | undefined> {
    if (this.logoDataUrl !== undefined) return this.logoDataUrl ?? undefined;
    try {
      const res = await fetch(`${cvBaseHref}/assets/vm_logo.png`);
      if (!res.ok) { this.logoDataUrl = null; return undefined; }
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      this.logoDataUrl = dataUrl;
      return dataUrl;
    } catch {
      this.logoDataUrl = null;
      return undefined;
    }
  }

  private hexToRgba(hex: string, opacity: number): string {
    const clean = (hex || this.DEFAULT_STICKY_BOX_HEX).replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) || 0;
    const g = parseInt(clean.substring(2, 4), 16) || 0;
    const b = parseInt(clean.substring(4, 6), 16) || 0;
    const a = Math.min(1, Math.max(0.05, opacity));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  /** Parses a stored "rgba(r,g,b,a)" (or plain "#rrggbb") box_color back into a hex + opacity pair for the color picker. Returns null if unparseable so callers can fall back to defaults. */
  private rgbaToHexOpacity(color?: string | null): { hex: string; opacity: number } | null {
    if (!color) return null;
    const rgbaMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/i);
    if (rgbaMatch) {
      const [, r, g, b, a] = rgbaMatch;
      const hex = '#' + [r, g, b].map(v => (+v).toString(16).padStart(2, '0')).join('');
      return { hex, opacity: a !== undefined ? parseFloat(a) : 1 };
    }
    if (/^#?[0-9a-f]{6}$/i.test(color)) {
      return { hex: color.startsWith('#') ? color : '#' + color, opacity: 1 };
    }
    return null;
  }

  /** Live inline style for a saved sticky note (uses its own box_color/text_color, falling back to the default amber/dark-slate combo — dark-slate text stays readable in both light and dark app themes since it never relies on the theme's own text color variable). */
  /** Just the hex swatch color for a saved note (used to color its toggle icon). */
  stickyBoxHex(c: CommentPin): string {
    const parsed = this.rgbaToHexOpacity(c.box_color);
    return parsed?.hex || this.DEFAULT_STICKY_BOX_HEX;
  }

  stickyNoteStyle(c: CommentPin): { [key: string]: string } {
    const parsed = this.rgbaToHexOpacity(c.box_color);
    const background = c.box_color || this.hexToRgba(this.DEFAULT_STICKY_BOX_HEX, this.DEFAULT_STICKY_OPACITY);
    const borderHex = parsed?.hex || this.DEFAULT_STICKY_BOX_HEX;
    const style: { [key: string]: string } = {
      background,
      'border-color': borderHex,
      color: c.text_color || this.DEFAULT_STICKY_TEXT_HEX
    };
    // Re-apply the last saved size so a manually-resized note keeps its
    // dimensions after a reload instead of snapping back to the CSS
    // default (200px / auto height) every time.
    if (c.width_px) style['width'] = `${c.width_px}px`;
    if (c.height_px) style['height'] = `${c.height_px}px`;
    return style;
  }

  /** Persists a note's size once the user stops dragging its resize handle (debounced inside StickyResizeWatchDirective). Updates the local model immediately so the size sticks even before the request resolves. */
  onPinResized(c: CommentPin, size: { width: number; height: number }) {
    if (!this.canWrite) return;
    c.width_px = size.width;
    c.height_px = size.height;
    this.api.post<any>(`/comparison-comments/${c.id}/size`, { width_px: size.width, height_px: size.height }).subscribe({
      error: () => this.toast.error('Failed to save note size')
    });
  }

  /** Live inline style for the draft note while it's being composed, reflecting the currently-picked (not-yet-saved) color/opacity. */
  draftNoteStyle(): { [key: string]: string } {
    if (!this.draftPin) return {};
    return {
      background: this.hexToRgba(this.draftPin.boxHex, this.draftPin.opacity),
      'border-color': this.draftPin.boxHex,
      color: this.draftPin.textHex
    };
  }

  /** Live inline style for a note currently in edit mode, reflecting the picker's in-progress selection. Still takes the comment so its saved width/height carry over while editing instead of the note jumping back to the CSS default size. */
  editingNoteStyle(c?: CommentPin): { [key: string]: string } {
    const style: { [key: string]: string } = {
      background: this.hexToRgba(this.editingPinBoxHex, this.editingPinOpacity),
      'border-color': this.editingPinBoxHex,
      color: this.editingPinTextHex
    };
    if (c?.width_px) style['width'] = `${c.width_px}px`;
    if (c?.height_px) style['height'] = `${c.height_px}px`;
    return style;
  }

  // Bound setter callbacks handed to the shared #colorPickerRow template
  // (declared as arrow-function properties, not methods, so `this` stays
  // correct when the template invokes them directly as functions).
  applyPresetToDraftBound = (preset: { box: string; text: string }) => this.applyPresetToDraft(preset);
  applyPresetToEditingBound = (preset: { box: string; text: string }) => this.applyPresetToEditing(preset);
  setDraftBoxHex = (hex: string) => { if (this.draftPin) this.draftPin.boxHex = hex; };
  setDraftTextHex = (hex: string) => { if (this.draftPin) this.draftPin.textHex = hex; };
  setDraftOpacity = (op: number) => { if (this.draftPin) this.draftPin.opacity = op; };
  setEditingBoxHex = (hex: string) => { this.editingPinBoxHex = hex; };
  setEditingTextHex = (hex: string) => { this.editingPinTextHex = hex; };
  setEditingOpacity = (op: number) => { this.editingPinOpacity = op; };

  // ============================================================
  // SURFACE SIZING (still needed for high-res rasterization on download)
  // ============================================================

  /** Reads the intrinsic (unscaled) pixel size of whatever's inside a .cv-surface element — the <img> for screenshots, or the <canvas> for PDF/PPTX pages. */
  private naturalSizeOfSurface(surface: HTMLElement): NaturalSize | null {
    const img = surface.querySelector('img') as HTMLImageElement | null;
    if (img && img.naturalWidth) return { width: img.naturalWidth, height: img.naturalHeight };
    const canvas = surface.querySelector('canvas') as HTMLCanvasElement | null;
    if (canvas && canvas.width) return { width: canvas.width, height: canvas.height };
    return null;
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
      doc_type: this.paneDocTypeKey(pane),
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

  private itemStatusKey(docType: string, pageKey: string): string {
    return `${docType}::${pageKey}`;
  }

  /** Loads the mark-final status of every item for the given side's current doc type + version. */
  loadItemStatusesFor(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    if (!pane.docType || !this.topicId) return;

    const key = this.paneDocTypeKey(pane);
    this.api.get<any>(`/topics/${this.topicId}/item-status?doc_type=${key}`).subscribe({
      next: (r: any) => {
        // Drop any previously-loaded statuses for this doc_type+version
        // before merging in the fresh set, same "replace this slice"
        // pattern used by loadCommentsFor() for the comments array.
        const kept: Record<string, ItemStatus> = {};
        for (const existingKey of Object.keys(this.itemStatuses)) {
          if (!existingKey.startsWith(`${key}::`)) kept[existingKey] = this.itemStatuses[existingKey];
        }
        for (const status of (r?.data || []) as ItemStatus[]) {
          kept[this.itemStatusKey(status.doc_type as any, status.page_key)] = status;
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
    return this.itemStatuses[this.itemStatusKey(this.paneDocTypeKey(pane), pageKey)];
  }

  isFinal(side: 'left' | 'right', index: number): boolean {
    return !!this.statusFor(side, index)?.is_final;
  }

  /** Flips a page/slide/screenshot between "final" and "pending", recording who did it. */
  toggleFinal(side: 'left' | 'right', index: number) {
    const pane = this.paneOf(side);
    const pageKey = pane.items[index]?.pageKey;
    if (!pane.docType || !pageKey || !this.topicId) return;
    const docType = this.paneDocTypeKey(pane);

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

  // ============================================================
  // DOWNLOAD (client-side, no backend changes) — always exports a PDF.
  // Every doc type (screenshots / PDF / PPTX) is already rendered as either
  // an <img> or a <canvas> inside each item's .cv-surface, so export works
  // the same way regardless of doc type: rasterize each surface to a canvas,
  // then assemble the pages into a PDF, with a crisp comment block appended
  // below each page's image (no pins, no author name).
  // ============================================================

  downloadMenuOpen = false;
  downloadingSide: 'left' | 'right' | null = null;

  /**
   * Renders one item's surface (image or canvas) onto a fresh canvas.
   *
   * Screenshots are the special case here: the on-screen <img> is loaded
   * directly from SCREENSHOT_BASE (a different origin than the app, and
   * without a `crossorigin` attribute — see the template), which means the
   * browser marks any canvas we draw it onto as "tainted". A tainted
   * canvas's toDataURL()/toBlob() throws a SecurityError instead of
   * producing image data, which is exactly why "download with comments"
   * silently did nothing for Screenshots specifically while working fine
   * for PDF/PPTX (those are rendered from bytes fetched via fetch(), never
   * from a cross-origin <img>). The fix: for screenshots, re-fetch the
   * same URL ourselves as a blob and draw a same-origin-safe Image built
   * from an object URL, instead of drawing the on-screen <img> directly.
   *
   * Screenshots are also drawn at a fixed minimum pixel width (upscaling
   * with the browser's own smoothing) so small source images don't come
   * out blurry once placed on an A4-width PDF page. PDF/PPTX pages are
   * already rendered at a high pixel density by their own render pipeline,
   * so their natural canvas size is used as-is.
   */
  private async rasterizeItem(side: 'left' | 'right', index: number): Promise<HTMLCanvasElement | null> {
    const pane = this.paneOf(side);
    const surface = document.getElementById(side === 'left' ? `leftSurface-${index}` : `rightSurface-${index}`);
    if (!surface) return null;

    let source: CanvasImageSource | null = null;
    let naturalWidth = 0;
    let naturalHeight = 0;
    let isScreenshot = false;

    if (pane.docType === 'screenshots') {
      isScreenshot = true;
      const imageUrl = pane.items[index]?.imageUrl;
      if (!imageUrl) return null;
      try {
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        try {
          const el = new Image();
          await new Promise<void>((resolve, reject) => {
            el.onload = () => resolve();
            el.onerror = () => reject(new Error('Could not decode screenshot image'));
            el.src = objectUrl;
          });
          source = el;
          naturalWidth = el.naturalWidth;
          naturalHeight = el.naturalHeight;
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      } catch (e: any) {
        this.toast.error(`Failed to load "${pane.items[index]?.label || 'screenshot'}" for download: ${e?.message || 'unknown error'}`);
        return null;
      }
    } else {
      const canvas = surface.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas || !canvas.width) return null;
      source = canvas;
      naturalWidth = canvas.width;
      naturalHeight = canvas.height;
    }

    if (!source || !naturalWidth || !naturalHeight) return null;

    // Upscale small screenshots so exported text/detail stays crisp; leave
    // already-high-res PDF/PPTX canvases untouched.
    const MIN_EXPORT_WIDTH = 1600;
    const upscale = isScreenshot && naturalWidth < MIN_EXPORT_WIDTH ? MIN_EXPORT_WIDTH / naturalWidth : 1;
    const outWidth = Math.round(naturalWidth * upscale);
    const outHeight = Math.round(naturalHeight * upscale);

    const out = document.createElement('canvas');
    out.width = outWidth;
    out.height = outHeight;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, outWidth, outHeight);

    return out;
  }

  /**
   * Draws the comment thread for one page/slide/screenshot as a clean,
   * left-aligned text block directly on a jsPDF page below its image —
   * rendered as real vector text (not burned into the rasterized page
   * canvas), which is what actually fixes the blurriness: text drawn by
   * jsPDF stays sharp at any zoom, unlike text painted onto a canvas that
   * then gets JPEG-compressed and scaled to fit the page. No author name is
   * included — comments show only their text, page label (added by the
   * caller), and resolved state.
   */
  private drawCommentBlock(pdf: jsPDF, comments: CommentPin[], x: number, startY: number, maxWidth: number): number {
    const BRAND = this.BRAND;
    const INK = { r: 30, g: 32, b: 44 };
    const MUTED = { r: 120, g: 124, b: 140 };
    const CARD_BG = { r: 246, g: 248, b: 250 };
    const CARD_BORDER = { r: 222, g: 230, b: 235 };
    const RESOLVED = { r: 22, g: 163, b: 74 };

    let y = startY;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9.5);
    pdf.setTextColor(BRAND.r, BRAND.g, BRAND.b);
    pdf.text(`Comments (${comments.length})`, x, y);
    y += 12;

    for (const c of comments) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      const lines = pdf.splitTextToSize(c.text, maxWidth - 22);
      const metaLine = c.resolved ? `${c.created_at}   ·   Resolved` : c.created_at;
      const cardHeight = 12 + 11 + lines.length * 12.5 + 8;

      pdf.setFillColor(CARD_BG.r, CARD_BG.g, CARD_BG.b);
      pdf.setDrawColor(CARD_BORDER.r, CARD_BORDER.g, CARD_BORDER.b);
      pdf.roundedRect(x, y, maxWidth, cardHeight, 3, 3, 'FD');
      const accent = c.resolved ? RESOLVED : BRAND;
      pdf.setFillColor(accent.r, accent.g, accent.b);
      pdf.roundedRect(x, y, 3, cardHeight, 1.2, 1.2, 'F');

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(MUTED.r, MUTED.g, MUTED.b);
      pdf.text(metaLine, x + 10, y + 12);
      if (c.author) {
        pdf.setFont('helvetica', 'italic');
        pdf.text(c.author, x + maxWidth - 10, y + 12, { align: 'right' });
      }

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor(INK.r, INK.g, INK.b);
      pdf.text(lines, x + 10, y + 27);

      y += cardHeight + 8;
    }
    return y;
  }

  /** Ensures every item on a side is actually rendered (scrolled into being, PDF/PPTX pages painted) before we try to rasterize it — the vertical list only guarantees the currently-visible pages have drawn. */
  private async ensureAllItemsRendered(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    if (pane.docType === 'claude_pdf') {
      await this.renderAllPdfPages(pane, side);
    } else if (pane.docType === 'claude_ppt' || pane.docType === 'gpt_ppt') {
      for (let i = 0; i < pane.items.length; i++) {
        await this.renderPptxSlide(pane, i);
      }
    }
    // Screenshots render themselves via <img> as soon as they're in the DOM
    // (all items are always mounted in the vertical list), so nothing to do there.
  }

  /** Downloads a PDF with the page images plus each page's comments printed in crisp vector text below it. */
  async downloadWithComments(side: 'left' | 'right') {
    await this.runDownload(side, 'pages-pdf');
  }

  /** Downloads a plain text/PDF log of every comment (no page images) — grouped by page. */
  async downloadCommentLog(side: 'left' | 'right') {
    await this.runDownload(side, 'log-pdf');
  }

  private async runDownload(side: 'left' | 'right', kind: 'pages-pdf' | 'log-pdf') {
    const pane = this.paneOf(side);
    if (!pane.docType || !pane.items.length) {
      this.toast.error('Nothing to download for this side yet.');
      return;
    }
    this.downloadMenuOpen = false;
    this.downloadingSide = side;
    try {
      if (kind === 'log-pdf') {
        await this.buildCommentLogPdf(side);
      } else {
        await this.ensureAllItemsRendered(side);
        await this.buildPagesPdf(side);
      }
    } catch (e: any) {
      this.toast.error('Failed to build the download: ' + (e?.message || 'unknown error'));
    } finally {
      this.downloadingSide = null;
    }
  }

  private filenameFor(side: 'left' | 'right', suffix: string): string {
    const pane = this.paneOf(side);
    const baseLabel = pane.docType ? this.DOC_LABEL[pane.docType] : 'document';
    const docLabel = pane.version ? `${baseLabel}_${pane.version}` : baseLabel;
    const topicName = (this.topic?.topic_code || this.topic?.name || 'topic').toString().replace(/[^\w\-]+/g, '_');
    return `${topicName}_${docLabel.replace(/\s+/g, '_')}_${suffix}.pdf`;
  }

  /** Builds a PDF from every rendered page/slide/screenshot of a side, with each page's comment thread printed as sharp vector text underneath it. */
  private async buildPagesPdf(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    let pdf: jsPDF | null = null;

    for (let i = 0; i < pane.items.length; i++) {
      const canvas = await this.rasterizeItem(side, i);
      if (!canvas) continue;

      const comments = this.commentsForIndex(side, i);
      const marginHeightPt = comments.length ? 30 + comments.length * 44 : 0;

      // Page size in points, matching the image's aspect ratio, plus room
      // for the comment block if there are any comments on this page.
      const pageWidthPt = 595; // A4-ish width in points, images scaled to fit
      const pageImgHeightPt = (canvas.height / canvas.width) * pageWidthPt;
      const pageHeightPt = pageImgHeightPt + marginHeightPt + 20;

      if (!pdf) {
        pdf = new jsPDF({ unit: 'pt', format: [pageWidthPt, pageHeightPt] });
      } else {
        pdf.addPage([pageWidthPt, pageHeightPt], pageHeightPt > pageWidthPt ? 'p' : 'l');
      }

      // PNG (not JPEG) preserves sharp edges/text in the source image — the
      // previous JPEG-at-0.92 encoding was the other main source of blur on
      // screenshots that already contained small text.
      const imgData = canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', 0, 10, pageWidthPt, pageImgHeightPt, undefined, 'FAST');

      if (comments.length) {
        this.drawCommentBlock(pdf, comments, 14, pageImgHeightPt + 24, pageWidthPt - 28);
      }
    }

    if (!pdf) {
      this.toast.error('Nothing rendered to export yet.');
      return;
    }
    pdf.save(this.filenameFor(side, 'with_comments'));
  }

  /** Builds a text-only PDF listing every comment for a side, grouped by page/slide, with a branded VidyaMine letterhead (logo + brand blue) up top and each comment card showing its publisher (the admin who wrote it). */
  private async buildCommentLogPdf(side: 'left' | 'right') {
    const pane = this.paneOf(side);
    const all = this.allCommentsFor(side);
    if (!all.length) {
      this.toast.error('No comments to include in the log.');
      return;
    }

    const logoDataUrl = await this.loadLogoDataUrl();

    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX = 40;
    const contentWidth = pageWidth - marginX * 2;

    // Brand palette — sampled from the VidyaMine logo blue (#00709e).
    const BRAND = this.BRAND;
    const BRAND_DARK = this.BRAND_DARK;
    const BRAND_TINT = { r: 232, g: 244, b: 249 }; // very light wash of BRAND, for the header background
    const INK = { r: 30, g: 32, b: 44 };
    const MUTED = { r: 120, g: 124, b: 140 };
    const CARD_BG = { r: 246, g: 249, b: 251 };
    const CARD_BORDER = { r: 219, g: 232, b: 238 };
    const RESOLVED = { r: 22, g: 163, b: 74 };

    const resolvedCount = all.filter(c => c.resolved).length;
    const topicName = this.topic?.name || '';
    const topicCode = this.topic?.topic_code || '';
    const docLabel = pane.docType
      ? (pane.version ? `${this.DOC_LABEL[pane.docType]} (${this.versionLabel(pane.version)})` : this.DOC_LABEL[pane.docType])
      : '';

    /** Draws the header band (called on page 1, and as a slim repeat on later pages). Light brand-blue wash with a solid-blue accent strip, logo mark, and — on page 1 only — the topic title, topic code, doc label, and a comment-count summary chip. */
    const drawHeader = (isFirstPage: boolean): number => {
      const bandHeight = isFirstPage ? 112 : 44;

      pdf.setFillColor(BRAND_TINT.r, BRAND_TINT.g, BRAND_TINT.b);
      pdf.rect(0, 0, pageWidth, bandHeight, 'F');
      pdf.setFillColor(BRAND.r, BRAND.g, BRAND.b);
      pdf.rect(0, 0, pageWidth, 4, 'F');
      pdf.setDrawColor(CARD_BORDER.r, CARD_BORDER.g, CARD_BORDER.b);
      pdf.setLineWidth(0.75);
      pdf.line(0, bandHeight, pageWidth, bandHeight);

      const logoSize = isFirstPage ? 34 : 20;
      const logoX = marginX;
      const logoY = isFirstPage ? 20 : 12;
      let textX = marginX;
      if (logoDataUrl) {
        try {
          pdf.addImage(logoDataUrl, 'PNG', logoX, logoY, logoSize, logoSize, undefined, 'FAST');
          textX = logoX + logoSize + 12;
        } catch { /* logo failed to decode — fall back to text-only header */ }
      }

      if (isFirstPage) {
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(11);
        pdf.setTextColor(BRAND_DARK.r, BRAND_DARK.g, BRAND_DARK.b);
        pdf.text('VIDYAMINE', textX, logoY + 12);

        pdf.setFontSize(19);
        pdf.setTextColor(INK.r, INK.g, INK.b);
        pdf.text(topicName || 'Comment Log', textX, logoY + 32);

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.setTextColor(MUTED.r, MUTED.g, MUTED.b);
        const subBits = [topicCode && `Topic ${topicCode}`, `${docLabel} — Comment Log`].filter(Boolean).join('   ·   ');
        if (subBits) pdf.text(subBits, textX, logoY + 47);

        // Right-aligned summary chip.
        const summary = `${all.length} comment${all.length === 1 ? '' : 's'}   ·   ${resolvedCount} resolved`;
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(9.5);
        pdf.setTextColor(BRAND.r, BRAND.g, BRAND.b);
        pdf.text(summary, pageWidth - marginX, logoY + 12, { align: 'right' });
      } else {
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(10.5);
        pdf.setTextColor(INK.r, INK.g, INK.b);
        pdf.text(topicName || 'Comment Log', textX, logoY + 14);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(MUTED.r, MUTED.g, MUTED.b);
        pdf.text(`${docLabel} — Comment Log`, pageWidth - marginX, logoY + 14, { align: 'right' });
      }
      return bandHeight + 22;
    };

    let y = drawHeader(true);

    const ensureSpace = (needed: number) => {
      if (y + needed > pageHeight - 44) {
        pdf.addPage();
        y = drawHeader(false);
      }
    };

    let lastPageLabel = '';
    for (const c of all) {
      if (c.pageLabel !== lastPageLabel) {
        lastPageLabel = c.pageLabel;
        ensureSpace(30);
        y += 4;
        pdf.setFillColor(BRAND.r, BRAND.g, BRAND.b);
        pdf.roundedRect(marginX, y - 11, pdf.getTextWidth(lastPageLabel) + 16, 16, 3, 3, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(9.5);
        pdf.setTextColor(255, 255, 255);
        pdf.text(lastPageLabel, marginX + 8, y);
        y += 18;
      }

      // Pre-measure the card height so we can draw the background box first.
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10.5);
      const lines = pdf.splitTextToSize(c.text, contentWidth - 24);
      const cardHeight = 16 + lines.length * 13.5 + 10;
      ensureSpace(cardHeight + 10);

      pdf.setFillColor(CARD_BG.r, CARD_BG.g, CARD_BG.b);
      pdf.setDrawColor(CARD_BORDER.r, CARD_BORDER.g, CARD_BORDER.b);
      pdf.roundedRect(marginX, y, contentWidth, cardHeight, 4, 4, 'FD');
      // Left accent bar — green if resolved, brand blue otherwise.
      const accent = c.resolved ? RESOLVED : BRAND;
      pdf.setFillColor(accent.r, accent.g, accent.b);
      pdf.roundedRect(marginX, y, 3.5, cardHeight, 1.5, 1.5, 'F');

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(MUTED.r, MUTED.g, MUTED.b);
      const meta = c.resolved ? `${c.created_at}   ·   Resolved` : c.created_at;
      pdf.text(meta, marginX + 12, y + 14);
      if (c.author) {
        pdf.setFont('helvetica', 'italic');
        pdf.setFontSize(8.5);
        pdf.setTextColor(BRAND.r, BRAND.g, BRAND.b);
        pdf.text(c.author, marginX + contentWidth - 12, y + 14, { align: 'right' });
      }

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10.5);
      pdf.setTextColor(INK.r, INK.g, INK.b);
      pdf.text(lines, marginX + 12, y + 30);

      y += cardHeight + 10;
    }

    // Footer on every page: light rule + brand tagline + page number.
    const totalPages = pdf.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);
      pdf.setDrawColor(CARD_BORDER.r, CARD_BORDER.g, CARD_BORDER.b);
      pdf.setLineWidth(0.5);
      pdf.line(marginX, pageHeight - 30, pageWidth - marginX, pageHeight - 30);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(MUTED.r, MUTED.g, MUTED.b);
      pdf.text('VidyaMine', marginX, pageHeight - 18);
      pdf.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, pageHeight - 18, { align: 'right' });
    }

    pdf.save(this.filenameFor(side, 'comment_log'));
  }
}