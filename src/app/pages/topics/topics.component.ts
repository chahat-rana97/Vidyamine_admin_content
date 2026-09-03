import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ViewChildren, QueryList, ElementRef, AfterViewChecked, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import JSZip from 'jszip';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';
import { HttpClient, HttpHeaders } from '@angular/common/http';

type TrackType = 'script' | 'slide' | 'quiz' | 'exer' | 'youtube' | 'audio';

const TRACK_TYPES: TrackType[] = ['slide', 'quiz', 'exer', 'script', 'youtube'];
const TRACK_LABEL: Record<TrackType, string> = {
  script: 'Script & Audio', slide: 'Slide', quiz: 'Quiz', exer: 'Exercise', youtube: 'YouTube', audio: 'Audio'
};
const TRACK_ICON: Record<TrackType, string> = {
  script: '📝', slide: '📊', quiz: '❓', exer: '🧮', youtube: '📹', audio: '🎧'
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
type SlideDocType = 'claude_ppt' | 'gpt_ppt' | 'claude_pdf' | 'gpt_pdf';

interface SlideDocDef {
  type: SlideDocType;
  label: string;
  suffix: string;       // appended to topic_code to form the required filename base (Production/Original)
  exts: string[];       // allowed extensions (lowercase, no dot)
  field: string;         // property name on the topic row holding the saved filename (Production/Original)
}

const SLIDE_DOC_TYPES: SlideDocType[] = ['claude_ppt', 'gpt_ppt', 'claude_pdf', 'gpt_pdf'];
const SLIDE_DOC_DEFS: Record<SlideDocType, SlideDocDef> = {
  // .pptx only (not legacy binary .ppt) — the Compare view renders PPTX
  // client-side and cannot render old binary .ppt files at all.
  claude_ppt: { type: 'claude_ppt', label: 'Claude PPT',  suffix: '_GPT_Clau_PPT', exts: ['pptx'], field: 'slide_claude_ppt' },
  claude_pdf: { type: 'claude_pdf', label: 'Claude PDF',  suffix: '_GPT_Clau_PDF', exts: ['pdf'],  field: 'slide_claude_pdf' },
  gpt_ppt:    { type: 'gpt_ppt',    label: 'ChatGPT PPT', suffix: '_GPT_Chat_PPT', exts: ['pptx'], field: 'slide_gpt_ppt' },
  gpt_pdf:    { type: 'gpt_pdf',    label: 'ChatGPT PDF', suffix: '_GPT_Chat_PDF', exts: ['pdf'],  field: 'slide_gpt_pdf' },
};

/** Compact short-form labels for the Slide tile's tab buttons (full names stay in the modal/picker via SLIDE_DOC_DEFS.label). */
const SLIDE_DOC_SHORT_LABEL: Record<SlideDocType, string> = {
  claude_ppt: 'CL_PPT',
  gpt_ppt: 'CH_PPT',
  claude_pdf: 'CL_PDF',
  gpt_pdf: 'CH_PDF',
};

/** The three tiles/sections in the Slide table cell. 'production' has Original + v1..v5 versions;
 *  'final' and 'self' are single-slot each, suffixed with _F / _S respectively. */
type SlideTier = 'production' | 'final' | 'self';

/**
 * Quiz / Exercise JSON + Script (Word) attachment types. Single slot each
 * (no versions), saved to the same server folder (topic_attachments/) as
 * the Slide docs. Required filename is a PREFIX + topic_code (not a suffix
 * like the slide docs): QJ_{topic_code}.json for quiz, AJ_{topic_code}.json
 * for exercise, SC_{topic_code}.doc|docx for script.
 */
type JsonDocType = 'quiz' | 'quiz_purified' | 'exercise' | 'script';

interface JsonDocDef {
  type: JsonDocType;
  label: string;
  prefix: string;   // prepended to topic_code to form the required filename base
  field: string;     // property name on the topic row holding the saved filename
  exts: string[];    // allowed extensions (lowercase, no dot)
}

const JSON_DOC_DEFS: Record<JsonDocType, JsonDocDef> = {
  quiz:          { type: 'quiz',          label: 'Quiz JSON',          prefix: 'QJ_', field: 'quiz_json',          exts: ['json'] },
  quiz_purified: { type: 'quiz_purified', label: 'Purified Quiz JSON', prefix: 'PQ_', field: 'quiz_purified_json', exts: ['json'] },
  exercise:      { type: 'exercise',      label: 'Exercise JSON',      prefix: 'AJ_', field: 'exercise_json',      exts: ['json'] },
  script:        { type: 'script',        label: 'Script',             prefix: 'SC_', field: 'script_file',        exts: ['doc', 'docx'] },
};

/**
 * Generic "Attach file" doc on a topic, shown next to Screenshots.
 * Single slot, ANY file extension allowed. Required filename:
 * TF_{topic_code}.{ext} — enforced client + server. Saved to the same
 * server folder (/Screenshots) as screenshots, DB column `topic_doc`.
 */
const TOPIC_DOC_PREFIX = 'TF_';
const TOPIC_DOC_FIELD = 'topic_doc';
const TOPIC_DOC_LABEL = 'Topic File';

/**
 * Audio attachment on a topic (shown as its own "Audio" tile, right after
 * YouTube). Single slot, saved to its own server folder topic_audios/
 * (NOT topic_attachments/), DB column `audio_file`. Required filename:
 * {LA_|PA_|SA_}{topic_code}.{mp3|wav|m4a|ogg} — any one of the three
 * accepted prefixes — enforced client + server, same case-insensitive
 * prefix+topic_code convention as Quiz/Exercise/Script.
 */
const AUDIO_PREFIXES = ['LA_', 'PA_', 'SA_'];
const AUDIO_PREFIX = AUDIO_PREFIXES[0]; // default used for "Rename & Continue"
const AUDIO_FIELD = 'audio_file';
const AUDIO_LABEL = 'Audio';
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'ogg'];

/** Maps a track tile type to its JSON doc type, where applicable. */
const TRACK_TO_JSON_DOC: Partial<Record<TrackType, JsonDocType>> = {
  quiz: 'quiz',
  exer: 'exercise',
  script: 'script',
};

/** Version slots, in addition to the "original" upload. Keep in sync with
 *  the backend's slideDocVersions(). null = original slot. */
type SlideVersion = 'v1' | 'v2' | 'v3' | 'v4' | 'v5';
const SLIDE_DOC_VERSIONS: SlideVersion[] = ['v1', 'v2', 'v3', 'v4', 'v5'];

/** One selectable slot for a given doc type: the original, or one of its versions (Production tier),
 *  or the single Final/Self slot. */
interface SlideDocSlot {
  version: SlideVersion | null; // null = original / n-a for final & self
  label: string;                // 'Original' | 'Version 1' | ... | 'Final' | 'Self'
  field: string;                // topic property holding the filename, e.g. slide_claude_ppt_v1 / _final / _self
  suffix: string;                // filename suffix required for this slot, e.g. _GPT_Clau_PPT_V1 / _F / _S
  tier: SlideTier;               // 'production' | 'final' | 'self'
}

/** Builds the ordered list of Production slots (Original, v1..v5) for a doc type def. */
function slideDocSlots(def: SlideDocDef): SlideDocSlot[] {
  const slots: SlideDocSlot[] = [
    { version: null, label: 'Original', field: def.field, suffix: def.suffix, tier: 'production' }
  ];
  for (const v of SLIDE_DOC_VERSIONS) {
    slots.push({
      version: v,
      label: `Version ${v.substring(1)}`,
      field: `${def.field}_${v}`,          // slide_claude_ppt_v1
      suffix: `${def.suffix}_${v.toUpperCase()}`, // _GPT_Clau_PPT_V1
      tier: 'production'
    });
  }
  return slots;
}

/** Builds the single Final slot for a doc type def: {topic_code}{suffix}_F.{ext}, column {field}_final. */
function slideDocFinalSlot(def: SlideDocDef): SlideDocSlot {
  return { version: null, label: 'Final', field: `${def.field}_final`, suffix: `${def.suffix}_F`, tier: 'final' };
}

/** Builds the single Self slot for a doc type def: {topic_code}{suffix}_S.{ext}, column {field}_self. */
function slideDocSelfSlot(def: SlideDocDef): SlideDocSlot {
  return { version: null, label: 'Self', field: `${def.field}_self`, suffix: `${def.suffix}_S`, tier: 'self' };
}

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
export class TopicsComponent implements OnInit, AfterViewInit, OnDestroy, AfterViewChecked {



  // Caching variables to prevent PDF sidebar iframe flickering
  safePdfUrl: SafeResourceUrl | null = null;
  pptUrl = '';
  scriptText = '';

  // Extended YouTube/AI parameters
  selectedTopic: any = null;
  ytPanelOpen = false;
  useRefDesc = true;
  useRefThumb = true;
  guidancePrompt = '';
  openaiKey = '';
  showApiKeyInput = false;
  generatingYt = false;
  generatingTopicId = '';
  ytPalettes = [
    {name:'Green/Gold',bg:'#003F36',accent:'#C9A227',text:'#FFFFFF'},
    {name:'Gold/Green',bg:'#C9A227',accent:'#003F36',text:'#23291F'},
    {name:'Brick',bg:'#9C4A3C',accent:'#F5EFE0',text:'#FFFFFF'},
    {name:'Blue',bg:'#2E5E7E',accent:'#C9A227',text:'#FFFFFF'},
  ];
  ytLayouts = ['Left text', 'Centered', 'Lower band'];
  tagline = 'पढ़ाई भी, ज़िंदगी भी';
  canvasNeedRedraw = false;
  sidePanelOpen = false;
  sidePanelKind: 'script' | 'ppt' | 'pdf' | null = null;
  refUploadedThumbnailImgs: string[] = [];
  ytPreviewImgUrl: string | null = null;
  ytGenMode: 'desc' | 'thumb' | 'both' = 'both';
  generatingThumbImage = false;
  generatingThumbTopics = new Set<string>();
  teacherPhotos: any[] = [];
  vaultPrompts: any[] = [];

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
  // Proxies the same files through the PHP backend (index.php) instead of the
  // static folder above. The static host doesn't send CORS headers and we
  // can't add them (shared server, no nginx/Apache config access) — but the
  // backend already has a matching route (/topics/{id}/json-doc/{docType})
  // that streams the file with Access-Control-Allow-Origin: * on every
  // response. Used only where the file needs to be fetch()'d by JS (e.g.
  // opening it in Topic Quiz review); direct links/downloads/iframes keep
  // using ATTACH_BASE since those aren't subject to CORS at all.
  readonly JSON_DOC_PROXY_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/index.php/topics';
  readonly MAX_SLIDE_DOC_MB = 5;
  SLIDE_DOC_TYPES = SLIDE_DOC_TYPES;
  SLIDE_DOC_DEFS = SLIDE_DOC_DEFS;
  SLIDE_DOC_SHORT_LABEL = SLIDE_DOC_SHORT_LABEL;

  // ── Audio tile ({LA_|PA_|SA_}{topic_code}.mp3|wav|m4a|ogg), own server folder ──
  readonly AUDIO_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/topic_audios';
  readonly MAX_AUDIO_MB = 25;

  // Modal state for the currently open slide-doc popup (null = closed)
  slideDocModal: {
    topic: any;
    def: SlideDocDef;
    slots: SlideDocSlot[];          // Original + v1..v5, in order
    activeSlot: SlideDocSlot;       // which slot is currently shown/acted on
    stage: 'picker' | 'view' | 'upload'; // 'picker' lists all slots; 'view'/'upload' act on activeSlot
    pickedFile: File | null;
    pickedName: string;             // basename (no ext) of the picked file, for the mismatch check
    pickedExt: string;
    nameMatches: boolean;
    sizeError: string;              // non-empty when picked file exceeds the size limit
    uploading: boolean;
    deleting: boolean;
    safeUrl: SafeResourceUrl | null;  // cached sanitized iframe src for the active slot's PDF (view stage only)
  } | null = null;

  // ── Quiz / Exercise JSON attachments ──
  JSON_DOC_DEFS = JSON_DOC_DEFS;
  readonly MAX_JSON_DOC_MB = 5;
  // Tracks which topic+docType is mid-upload, so only that button shows a spinner.
  uploadingJsonDoc: Record<string, boolean> = {}; // key: `${topicId}_${docType}`

  // ── Generic "Attach file" Topic Doc (next to Screenshots) ──
  readonly TOPIC_DOC_LABEL = TOPIC_DOC_LABEL;
  readonly MAX_TOPIC_DOC_MB = 5;
  uploadingTopicDoc: Record<number, boolean> = {}; // key: topicId

  // ── Screenshot ZIP export ──
  exportingZip = false;
  exportProgress = 0; // 0-100, for the progress UI

  exportingQuizZip = false;
  exportQuizProgress = 0; // 0-100, for the progress UI

  exportingPurifiedQuizZip = false;
  exportPurifiedQuizProgress = 0; // 0-100, for the progress UI

  exportingExerciseZip = false;
  exportExerciseProgress = 0; // 0-100, for the progress UI
  showExportMenu = false; // toggles the Screenshots / Quiz JSON / Purified Quiz JSON / Assignment JSON dropdown

  // ── "Open all in review" menu (next to the download/export button) ──
  // Lets the user open every topic's Quiz JSON / Purified Quiz JSON /
  // Assignment JSON for the WHOLE chapter at once in the Topic Quiz review
  // screen (as opposed to the single-topic 🔍 review button on each card).
  showOpenAllMenu = false;
  openingAllFor: JsonDocType | null = null; // which doc type is currently being bulk-loaded (for the spinner)
  openAllProgress = 0; // 0-100

  TRACK_TYPES = TRACK_TYPES;
  TRACK_LABEL = TRACK_LABEL;
  TRACK_ICON = TRACK_ICON;

  // ── Route context ──
  chapterId: number | null = null;
  chapter: any = null;

  @ViewChild('topicListEl') topicListEl?: ElementRef<HTMLElement>;

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
  statusFilter: string = '';
  assignedFilter: string = '';
  docFilter: string = '';
  filteredTopics: any[] = [];

  /** Topic list display mode — 'cards' is the original tile layout, 'table' is the compact admin-style table. Persisted per-browser. */
  viewMode: 'cards' | 'table' = (localStorage.getItem('vmss_topics_view_mode') as 'cards' | 'table') || 'table';

  setViewMode(mode: 'cards' | 'table'): void {
    if (this.isEditor) return; // editors are locked to Card view
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    try { localStorage.setItem('vmss_topics_view_mode', mode); } catch {}
  }

  // ── Final <-> Pending status change, unlock modal state ──
  savingStatusId: { [topicId: number]: boolean } = {};
  unlockModal: { open: boolean; topic: any | null; keyInput: string; error: string } = {
    open: false, topic: null, keyInput: '', error: ''
  };

  // ── Description edit modal state (Description column, hidden behind the
  // same ☑ checkbox toggle used for bulk-select) ──
  savingDescription: { [topicId: number]: boolean } = {};
  descriptionModal: { open: boolean; topic: any | null; textInput: string } = {
    open: false, topic: null, textInput: ''
  };

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService,
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private http: HttpClient
  ) {}

  /**
   * Opens the full-screen Compare view for a topic. Left/right doc types
   * are picked inside that screen (it shows its own picker on first load),
   * so we only need to pass the topic_id here.
   */
  openCompareView(topic: any) {
    this.saveScrollPosition();
    this.router.navigate(['/compare'], { queryParams: { topic_id: topic.id } });
  }

  openMobileContentEditor(topic: any) {
    this.saveScrollPosition();
    this.router.navigate(['/mobile-content'], {
      queryParams: {
        topic_id: topic.id,
        topic_code: topic.topic_code,
        topic_name: topic.name,
      }
    });
  }

  /** Topic id whose "open in review" QJ/PQ picker is currently open (null = none open). Quiz tile only — Exercise has just one JSON type so it still opens directly. */
  reviewPickerOpenFor: number | null = null;

  /** Eye-button click for the Quiz tile: if only one of QJ/PQ is attached, open it directly; if both are attached, show a small picker instead of guessing. Exercise (and anything else) keeps the old direct-open behavior via openQuizInReview(). */
  onReviewButtonClick(t: any, type: TrackType, event?: MouseEvent) {
    if (event) event.stopPropagation();
    if (type !== 'quiz') {
      const docType = this.trackJsonDocType(type);
      if (docType) this.openQuizInReview(t, docType);
      return;
    }

    const hasQj = this.jsonDocAttached(t, 'quiz');
    const hasPq = this.jsonDocAttached(t, 'quiz_purified');

    if (hasQj && hasPq) {
      this.reviewPickerOpenFor = this.reviewPickerOpenFor === t.id ? null : t.id;
      return;
    }
    this.reviewPickerOpenFor = null;
    if (hasQj) this.openQuizInReview(t, 'quiz');
    else if (hasPq) this.openQuizInReview(t, 'quiz_purified');
  }

  /** Called from the QJ/PQ picker dropdown. */
  pickReviewDoc(t: any, docType: JsonDocType) {
    this.reviewPickerOpenFor = null;
    this.openQuizInReview(t, docType);
  }

  closeReviewPicker() {
    this.reviewPickerOpenFor = null;
  }

  /**
   * Opens the Topic Quiz review pane with a specific attached Quiz/Exercise
   * JSON already loaded. Topic Quiz isn't a routed page — it's a pane toggled
   * by the legacy goTool('topicquiz') sidebar script — so we navigate back to
   * Home (which owns that pane), switch tools, then hand off the file via a
   * window hook that topic-quiz.ts registers on init.
   *
   * Fetches through the PHP proxy (/topics/{id}/json-doc/{docType}), not the
   * static topic_attachments/ URL — the static host has no CORS headers and
   * we can't add them (shared server), so a direct fetch() from the browser
   * gets blocked. The proxy route sends Access-Control-Allow-Origin: * like
   * every other API response.
   */
  openQuizInReview(t: any, docType: JsonDocType) {
    if (!t?.id) return;
    if (!this.jsonDocAttached(t, docType)) return;
    const filename = this.jsonDocFilename(t, docType);
    const fileUrl = `${this.JSON_DOC_PROXY_BASE}/${t.id}/json-doc/${docType}`;

    this.saveScrollPosition();
    this.router.navigate(['/']).then(() => {
      if (typeof (window as any).goTool === 'function') {
        (window as any).goTool('topicquiz');
      }
      // TopicQuiz is a standalone embedded component that's already mounted
      // once Home loads, but give it a beat to register its window hook on
      // first-ever activation before we call it.
      const tryOpen = (attemptsLeft: number) => {
        if (typeof (window as any).openTopicQuizFile === 'function') {
          (window as any).openTopicQuizFile(fileUrl, filename);
        } else if (attemptsLeft > 0) {
          setTimeout(() => tryOpen(attemptsLeft - 1), 150);
        } else {
          this.toast.error('Could not open Topic Quiz review — please try again.');
        }
      };
      tryOpen(10);
    });
  }

  // ── Scroll position memory: remembers where you were in the topic list
  // per chapter, so returning from Compare view (or any other screen) drops
  // you back where you left off instead of snapping to the top. ──
  private scrollPosKey(): string {
    return `vm_topics_scroll_${this.chapterId}`;
  }

  private saveScrollPosition() {
    const el = this.topicListEl?.nativeElement;
    if (!el || !this.chapterId) return;
    sessionStorage.setItem(this.scrollPosKey(), String(el.scrollTop));
  }

  /** True while restoreScrollPosition()'s retries are still in flight —
   *  guards against a reflow-triggered native scroll event (firing at
   *  scrollTop 0 mid-restore) overwriting the saved position with 0
   *  before our later retries get a chance to apply it. */
  private restoringScroll = false;

  onTopicListScroll() {
    // Persist continuously (not just on navigate-away) so a browser back
    // button / tab close / accidental refresh still restores correctly.
    if (this.restoringScroll) return;
    this.saveScrollPosition();
  }

  /** Restores the saved scroll position for this chapter, if any. Takes
   *  priority over the "jump to a specific topic" flow (focusTopicId) only
   *  when there's no explicit topic_id in the URL — an explicit deep link
   *  (e.g. from the Chapter Report) should still win.
   *
   *  Applied over a few animation frames (not just one setTimeout(0)) because
   *  tile heights keep growing for a bit after `topics` is first assigned —
   *  screenshot thumbnails and per-topic quiz/exercise counts finish loading
   *  slightly later and reflow the list, which would otherwise silently clip
   *  scrollTop back down before the browser has anywhere to actually scroll
   *  to yet. Re-applying a few times after that first paint makes it "stick"
   *  once the real (taller) layout is in. */
  private restoreScrollPosition(): boolean {
    if (this.focusTopicId) return false; // explicit deep link takes priority
    const saved = sessionStorage.getItem(this.scrollPosKey());
    if (saved === null) return false;
    const top = Number(saved);
    if (isNaN(top)) return false;

    this.restoringScroll = true;
    const apply = () => {
      const el = this.topicListEl?.nativeElement;
      if (el) el.scrollTop = top;
    };

    // Immediately (post-render), then a few more times as late content
    // (thumbnails, quiz/exercise badges) finishes loading and reflows.
    setTimeout(apply, 0);
    setTimeout(apply, 150);
    setTimeout(apply, 500);
    setTimeout(() => { apply(); this.restoringScroll = false; }, 1200);
    return true;
  }

  /** topic_id passed in from the Chapter Report screen, used to scroll to / highlight that topic once loaded. */
  focusTopicId: number | null = null;

  ngAfterViewChecked() {
    if (this.canvasNeedRedraw && this.ytPanelOpen && this.selectedTopic?.yt.thumb) {
      this.canvasNeedRedraw = false;
      this.drawThumbnail();
      this.drawRefThumbnail();
    }
  }

  loadApiKey() {
    this.openaiKey = localStorage.getItem('vmss_key') || '';
  }

  saveApiKey() {
    localStorage.setItem('vmss_key', this.openaiKey);
    this.showApiKeyInput = false;
    this.toast.success('OpenAI API Key saved');
  }

  saveApiKeyAuto() {
    localStorage.setItem('vmss_key', this.openaiKey);
  }

  ngOnInit() {
    this.loadApiKey();
    if (this.isEditor) this.viewMode = 'cards'; // editors are always locked to Card view

    const idParam = this.route.snapshot.queryParamMap.get('chapter_id')
      || this.route.snapshot.paramMap.get('chapter_id');
    this.chapterId = idParam ? Number(idParam) : null;

    const topicIdParam = this.route.snapshot.queryParamMap.get('topic_id');
    this.focusTopicId = topicIdParam ? Number(topicIdParam) : null;

    if (!this.chapterId) {
      this.toast.error('No chapter selected');
      this.goBackToChapters();
      return;
    }

    this.loadChapter();
    this.load();
    this.loadAssignableUsers();
    this.loadTeacherPhotos();
    this.loadVaultPrompts();
  }

  /** Navigates to the Chapter Report screen for the currently open chapter. */
  goToReport() {
    if (!this.chapterId) return;
    this.router.navigate(['/reports/chapters', this.chapterId]);
  }

  /** Scrolls to and briefly highlights the topic row referenced by focusTopicId (arrived from the report screen). */
  private scrollToFocusedTopic() {
    if (!this.focusTopicId) return;
    setTimeout(() => {
      const el = document.getElementById('topic-row-' + this.focusTopicId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('topic-row--focused');
        setTimeout(() => el.classList.remove('topic-row--focused'), 2500);
      }
    }, 300);
  }

  get canWrite() {
    return ['superadmin', 'admin', 'editor'].includes(this.auth.user?.role || '');
  }

  get canDelete() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  /** Editor role: card-view-only, read-mostly screen. Only the Compare button
   *  and the status/user/document filter dropdowns stay functional. */
  get isEditor(): boolean {
    return this.auth.user?.role === 'editor';
  }

  /** Swallows a click for any control that must stay view-only for editor,
   *  and shows a red "Access denied" toast so the click isn't silently a no-op. */
  blockIfEditor(event: Event): boolean {
    if (this.isEditor) {
      event.preventDefault();
      event.stopPropagation();
      this.toast.error('Access denied');
      return true;
    }
    return false;
  }

  // Table view: bulk-select checkboxes are hidden by default and toggled on
  // via the small checkbox icon next to the download/export icon.
  showTableCheckboxes = false;

  // ── Mandir Assets switchable view: replaces the Slide/Quiz/Exercise/
  // Script/YouTube columns with the Sanatan Mandir reference-data columns
  // (City, State, Time, Dharmik Mahatva, Darshan Time, Pramukh Utsav,
  // Yatra Sujhav, Pass Mein Dekhe), toggled next to the ☑ bulk-select icon.
  showMandirView = false;
  savingMandirAssets: { [topicId: number]: boolean } = {};

  toggleMandirView() {
    this.showMandirView = !this.showMandirView;
  }

  /** Auto-saves the whole mandir_assets object on blur, same pattern as saveTopicDescription(). */
  saveMandirAssets(t: any) {
    if (!t?.id) return;
    this.savingMandirAssets[t.id] = true;
    this.api.put<any>(`/topics/${t.id}/mandir-assets`, t.mandir_assets || {}).subscribe({
      next: (r: any) => {
        this.savingMandirAssets[t.id] = false;
        if (!r?.status) this.toast.error(r?.message || 'Failed to save mandir assets');
      },
      error: (err: any) => {
        this.savingMandirAssets[t.id] = false;
        this.toast.error(err?.error?.message || 'Failed to save mandir assets');
      }
    });
  }
  toggleTableCheckboxes() {
    this.showTableCheckboxes = !this.showTableCheckboxes;
  }

  /** Compact initials for the "Assigned" circle avatar, e.g. "Chahat Rana" -> "CR". */
  assigneeInitials(name: string | undefined | null): string {
    if (!name) return '—';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '—';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /** Deterministic background color for a user's avatar circle, derived from their
   *  id (falls back to name) so the same person always gets the same color. */
  private readonly AVATAR_PALETTE = [
    '#6366f1', '#ec4899', '#22c55e', '#f59e0b', '#06b6d4',
    '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#3b82f6'
  ];
  assigneeColor(id: string | number | undefined | null, name?: string | undefined | null): string {
    const key = String(id ?? name ?? '');
    if (!key) return this.AVATAR_PALETTE[0];
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return this.AVATAR_PALETTE[hash % this.AVATAR_PALETTE.length];
  }

  /** Short status-circle label: PN / PF / F for pending / pre-final / final. */
  statusShortLabel(t: any): string {
    if (this.isFinal(t)) return 'F';
    if (this.isPreFinal(t)) return 'PF';
    return 'PN';
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
        this.loadSavedYoutubeData();
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

  /** Toggles the small "Screenshots / Quiz JSON" export dropdown. */
  toggleExportMenu(event?: MouseEvent) {
    if (event) event.stopPropagation();
    this.showExportMenu = !this.showExportMenu;
  }

  /** Toggles the "Open QJ / PJ / AJ (all topics)" dropdown, next to the download button. */
  toggleOpenAllMenu(event?: MouseEvent) {
    if (event) event.stopPropagation();
    this.showOpenAllMenu = !this.showOpenAllMenu;
  }

  closeOpenAllMenu() {
    this.showOpenAllMenu = false;
  }

  closeExportMenu() {
    this.showExportMenu = false;
  }

  /** Called when the user picks "Screenshots" from the export dropdown. */
  onExportScreenshotsChosen() {
    this.showExportMenu = false;
    this.exportScreenshotsZip();
  }

  /** Called when the user picks "Quiz JSON" from the export dropdown. */
  onExportQuizJsonChosen() {
    this.showExportMenu = false;
    this.exportQuizJsonZip();
  }

  /** Called when the user picks "Purified Quiz JSON" from the export dropdown. */
  onExportPurifiedQuizJsonChosen() {
    this.showExportMenu = false;
    this.exportPurifiedQuizJsonZip();
  }

  /** Called when the user picks "Assignment JSON" from the export dropdown. */
  onExportExerciseJsonChosen() {
    this.showExportMenu = false;
    this.exportExerciseJsonZip();
  }

  // ============================================================
  // OPEN ALL TOPICS' QJ / PJ / AJ IN TOPIC QUIZ REVIEW (whole chapter at once)
  // ============================================================
  //
  // Unlike the per-topic 🔍 review button (openQuizInReview), which loads a
  // single topic's file, this fetches EVERY topic's attached file of the
  // chosen type (in topic sequence order) and hands the whole batch to the
  // Topic Quiz screen in one go, so all of the chapter's questions — topic 1,
  // then topic 2, etc. — show up together in one merged review session.
  // Topics with nothing attached for that doc type are silently skipped.

  /** Called when the user picks "Open QJ (all topics)" from the dropdown. */
  onOpenAllQuizChosen() {
    this.showOpenAllMenu = false;
    this.openAllTopicsInReview('quiz');
  }

  /** Called when the user picks "Open PJ (all topics)" from the dropdown. */
  onOpenAllPurifiedQuizChosen() {
    this.showOpenAllMenu = false;
    this.openAllTopicsInReview('quiz_purified');
  }

  /** Called when the user picks "Open AJ (all topics)" from the dropdown. */
  onOpenAllExerciseChosen() {
    this.showOpenAllMenu = false;
    this.openAllTopicsInReview('exercise');
  }

  private async openAllTopicsInReview(docType: JsonDocType) {
    if (this.openingAllFor) return;

    // Topics that actually have this doc type attached, kept in the same
    // order they're shown on this screen (topic sequence order).
    const targets = this.topics.filter(t => this.jsonDocAttached(t, docType));
    if (!targets.length) {
      this.toast.error(`No ${JSON_DOC_DEFS[docType].label} files attached for this chapter`);
      return;
    }

    this.openingAllFor = docType;
    this.openAllProgress = 0;

    try {
      // Fetch every attached file up front (through the CORS-safe proxy,
      // same route used elsewhere for these JSON docs).
      const files: { url: string; filename: string }[] = [];
      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        files.push({
          url: `${this.JSON_DOC_PROXY_BASE}/${t.id}/json-doc/${docType}`,
          filename: this.jsonDocFilename(t, docType) || ''
        });
        this.openAllProgress = Math.round(((i + 1) / targets.length) * 100);
      }

      this.saveScrollPosition();
      await this.router.navigate(['/']);
      if (typeof (window as any).goTool === 'function') {
        (window as any).goTool('topicquiz');
      }

      // Same "give it a beat to register its window hook" pattern as
      // openQuizInReview() — Topic Quiz is an always-alive pane, not a
      // routed component, so query params can't reach it.
      const tryOpen = (attemptsLeft: number) => {
        if (typeof (window as any).openTopicQuizFilesBulk === 'function') {
          (window as any).openTopicQuizFilesBulk(files);
        } else if (attemptsLeft > 0) {
          setTimeout(() => tryOpen(attemptsLeft - 1), 150);
        } else {
          this.toast.error('Could not open Topic Quiz review — please try again');
        }
      };
      tryOpen(20);

      if (failed > 0) {
        this.toast.error(`Opened with ${failed} of ${targets.length} file(s) failing to load — check console`);
      }
    } catch (e) {
      console.error('Failed to open all topics in review:', e);
      this.toast.error(`Failed to open ${JSON_DOC_DEFS[docType].label} files for review`);
    } finally {
      this.openingAllFor = null;
      this.openAllProgress = 0;
    }
  }

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

  // ============================================================
  // EXPORT ALL QUIZ JSON FILES AS A ZIP (flat, one file per topic)
  // ============================================================
  //
  // Produces a single .zip download named after the chapter code,
  // containing every topic's attached Quiz JSON file (QJ_{topic_code}.json)
  // directly at the zip root (no per-topic subfolders — these are single
  // files, not folders of screenshots). Topics with no Quiz JSON attached
  // are skipped.

  async exportQuizJsonZip() {
    if (this.exportingQuizZip) return;

    const topicsWithQuiz = this.topics.filter(t => !!t.quiz_json);
    if (!topicsWithQuiz.length) {
      this.toast.error('No Quiz JSON files attached for this chapter');
      return;
    }

    this.exportingQuizZip = true;
    this.exportQuizProgress = 0;

    try {
      const zip = new JSZip();

      const chapterFolderName = this.sanitizeForFsName(
        this.chapter?.chapter_code || this.chapter?.name || `chapter_${this.chapterId}`
      );
      const root = zip.folder(chapterFolderName)!;

      const totalFiles = topicsWithQuiz.length;
      let doneFiles = 0;
      let failedFiles = 0;

      for (const t of topicsWithQuiz) {
        const filename: string = t.quiz_json;
        // ATTACH_BASE (static folder) has no CORS headers, so a direct
        // fetch() of that URL is blocked by the browser and fails silently.
        // Use the backend proxy route instead — same one used by
        // openQuizInReview() — which streams the file with
        // Access-Control-Allow-Origin: * so fetch() can read it into a blob.
        const fetchUrl = `${this.JSON_DOC_PROXY_BASE}/${t.id}/json-doc/quiz`;
        try {
          const blob = await this.fetchAsBlob(fetchUrl);
          root.file(filename, blob);
        } catch (e) {
          failedFiles++;
          console.error('Failed to fetch quiz JSON for zip:', filename, e);
        }
        doneFiles++;
        this.exportQuizProgress = Math.round((doneFiles / totalFiles) * 100);
      }

      if (failedFiles === totalFiles) {
        this.toast.error('Failed to fetch any Quiz JSON files — please try again');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadName = `${chapterFolderName}.zip`;
      this.triggerBlobDownload(zipBlob, downloadName);
      if (failedFiles > 0) {
        this.toast.error(`Exported with ${failedFiles} of ${totalFiles} file(s) missing — check console`);
      } else {
        this.toast.success('Quiz JSON files exported');
      }
    } catch (e) {
      console.error('Quiz JSON zip export failed:', e);
      this.toast.error('Failed to export Quiz JSON files');
    } finally {
      this.exportingQuizZip = false;
      this.exportQuizProgress = 0;
    }
  }

  // ============================================================
  // EXPORT ALL PURIFIED QUIZ JSON FILES AS A ZIP (flat, one file per topic)
  // ============================================================
  //
  // Same as exportQuizJsonZip() above, but for the Purified Quiz JSON
  // attachment (PQ_{topic_code}.json / quiz_purified_json column) instead
  // of the regular Quiz JSON (QJ_).

  async exportPurifiedQuizJsonZip() {
    if (this.exportingPurifiedQuizZip) return;

    const topicsWithPurifiedQuiz = this.topics.filter(t => !!t.quiz_purified_json);
    if (!topicsWithPurifiedQuiz.length) {
      this.toast.error('No Purified Quiz JSON files attached for this chapter');
      return;
    }

    this.exportingPurifiedQuizZip = true;
    this.exportPurifiedQuizProgress = 0;

    try {
      const zip = new JSZip();

      const chapterFolderName = this.sanitizeForFsName(
        this.chapter?.chapter_code || this.chapter?.name || `chapter_${this.chapterId}`
      );
      const root = zip.folder(chapterFolderName)!;

      const totalFiles = topicsWithPurifiedQuiz.length;
      let doneFiles = 0;
      let failedFiles = 0;

      for (const t of topicsWithPurifiedQuiz) {
        const filename: string = t.quiz_purified_json;
        // Same CORS reasoning as exportQuizJsonZip() — go through the
        // backend proxy route, not the static topic_attachments/ URL.
        const fetchUrl = `${this.JSON_DOC_PROXY_BASE}/${t.id}/json-doc/quiz_purified`;
        try {
          const blob = await this.fetchAsBlob(fetchUrl);
          root.file(filename, blob);
        } catch (e) {
          failedFiles++;
          console.error('Failed to fetch purified quiz JSON for zip:', filename, e);
        }
        doneFiles++;
        this.exportPurifiedQuizProgress = Math.round((doneFiles / totalFiles) * 100);
      }

      if (failedFiles === totalFiles) {
        this.toast.error('Failed to fetch any Purified Quiz JSON files — please try again');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadName = `${chapterFolderName}_purified.zip`;
      this.triggerBlobDownload(zipBlob, downloadName);
      if (failedFiles > 0) {
        this.toast.error(`Exported with ${failedFiles} of ${totalFiles} file(s) missing — check console`);
      } else {
        this.toast.success('Purified Quiz JSON files exported');
      }
    } catch (e) {
      console.error('Purified Quiz JSON zip export failed:', e);
      this.toast.error('Failed to export Purified Quiz JSON files');
    } finally {
      this.exportingPurifiedQuizZip = false;
      this.exportPurifiedQuizProgress = 0;
    }
  }

  // ============================================================
  // EXPORT ALL ASSIGNMENT (EXERCISE) JSON FILES AS A ZIP (flat, one file per topic)
  // ============================================================
  //
  // Same as exportQuizJsonZip() / exportPurifiedQuizJsonZip() above, but for
  // the Exercise JSON attachment (AJ_{topic_code}.json / exercise_json
  // column) — shown to the user as "Assignment JSON".

  async exportExerciseJsonZip() {
    if (this.exportingExerciseZip) return;

    const topicsWithExercise = this.topics.filter(t => !!t.exercise_json);
    if (!topicsWithExercise.length) {
      this.toast.error('No Assignment JSON files attached for this chapter');
      return;
    }

    this.exportingExerciseZip = true;
    this.exportExerciseProgress = 0;

    try {
      const zip = new JSZip();

      const chapterFolderName = this.sanitizeForFsName(
        this.chapter?.chapter_code || this.chapter?.name || `chapter_${this.chapterId}`
      );
      const root = zip.folder(chapterFolderName)!;

      const totalFiles = topicsWithExercise.length;
      let doneFiles = 0;
      let failedFiles = 0;

      for (const t of topicsWithExercise) {
        const filename: string = t.exercise_json;
        // Same CORS reasoning as exportQuizJsonZip() — go through the
        // backend proxy route, not the static topic_attachments/ URL.
        const fetchUrl = `${this.JSON_DOC_PROXY_BASE}/${t.id}/json-doc/exercise`;
        try {
          const blob = await this.fetchAsBlob(fetchUrl);
          root.file(filename, blob);
        } catch (e) {
          failedFiles++;
          console.error('Failed to fetch assignment JSON for zip:', filename, e);
        }
        doneFiles++;
        this.exportExerciseProgress = Math.round((doneFiles / totalFiles) * 100);
      }

      if (failedFiles === totalFiles) {
        this.toast.error('Failed to fetch any Assignment JSON files — please try again');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadName = `${chapterFolderName}_assignment.zip`;
      this.triggerBlobDownload(zipBlob, downloadName);
      if (failedFiles > 0) {
        this.toast.error(`Exported with ${failedFiles} of ${totalFiles} file(s) missing — check console`);
      } else {
        this.toast.success('Assignment JSON files exported');
      }
    } catch (e) {
      console.error('Assignment JSON zip export failed:', e);
      this.toast.error('Failed to export Assignment JSON files');
    } finally {
      this.exportingExerciseZip = false;
      this.exportExerciseProgress = 0;
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

  // ================= TOPIC QUIZ API (Quiz/Exercise counts) =================
  // Same external quiz service used by the Topic Quiz editor and the MIS
  // report screen: https://rest.vidyamine.com/rest/dev/vm_doot/
  // One batch call returns every topic's counts; each topic_id carries a
  // QJ_ (Quiz) or AJ_ (Exercise) prefix over the plain topic_code, so the
  // response is split into two lookup maps keyed by the stripped code.
  private getQuizApiUrl(endpoint: string): string {
    let baseUrl = 'https://rest.vidyamine.com/rest/dev/vm_doot/';
    if (typeof window !== 'undefined') {
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const isDevServer = window.location.port === '4200';
      if (isLocalhost && !isDevServer) {
        baseUrl = 'apis/';
      }
      if (window.location.pathname.includes('/apis/')) {
        baseUrl = '';
      }
    }
    return baseUrl + endpoint;
  }

  private get quizApiHeaders(): Record<string, string> {
    return { 'Production': 'doot', 'VidyaMine': 'vidyamine' };
  }

  private quizBatchByTopicId = new Map<string, { total: number; approved: number; rejected: number; pending: number }>();
  private exerciseBatchByTopicId = new Map<string, { total: number; approved: number; rejected: number; pending: number }>();
  private quizBatchRequestToken = 0;

  /** Batch-fetches Quiz (QJ_) / Exercise (AJ_) counts for every topic on
   *  screen in one call, then merges into `this.topics` by topic_code. */
  loadQuizBatchForTopics(): void {
    const token = ++this.quizBatchRequestToken;
    const url = this.getQuizApiUrl('topic-quiz/topics/');
    fetch(url, { headers: this.quizApiHeaders })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => {
        if (token !== this.quizBatchRequestToken) return;
        this.quizBatchByTopicId.clear();
        this.exerciseBatchByTopicId.clear();
        if (json?.success && Array.isArray(json.topics)) {
          for (const t of json.topics) {
            if (!t?.topic_id) continue;
            const match = String(t.topic_id).match(/^(QJ|AJ|CJ|CA)_(.+)$/i);
            if (!match) continue;
            const prefix = match[1].toUpperCase();
            const strippedId = match[2];
            const stats = {
              total: Number(t.total) || 0,
              approved: Number(t.approved) || 0,
              rejected: Number(t.rejected) || 0,
              pending: Number(t.pending) || 0,
            };
            if (prefix === 'QJ') {
              this.quizBatchByTopicId.set(strippedId, stats);
            } else if (prefix === 'AJ') {
              this.exerciseBatchByTopicId.set(strippedId, stats);
            }
          }
        }
        this.applyQuizBatchToTopics();
      })
      .catch((err) => {
        if (token !== this.quizBatchRequestToken) return;
        console.error('[loadQuizBatchForTopics] fetch failed:', err, 'url:', url);
      });
  }

  private applyQuizBatchToTopics(): void {
    this.topics = this.topics.map(t => {
      if (!t.topic_code) return t;
      const q = this.quizBatchByTopicId.get(t.topic_code);
      const e = this.exerciseBatchByTopicId.get(t.topic_code);
      return {
        ...t,
        quiz_total: q?.total ?? 0,
        quiz_approved: q?.approved ?? 0,
        quiz_rejected: q?.rejected ?? 0,
        quiz_pending: q?.pending ?? 0,
        exercise_total: e?.total ?? 0,
        exercise_approved: e?.approved ?? 0,
        exercise_rejected: e?.rejected ?? 0,
        exercise_pending: e?.pending ?? 0,
      };
    });
    this.applyTopicFilter();
  }

  load() {
    this.loading = true;
    this.api.get<any>(`/topics?chapter_id=${this.chapterId}`).subscribe({
      next: (r: any) => {
        const list = Array.isArray(r?.data) ? r.data : [];
        list.sort((a: any, b: any) => Number(a.sequence) - Number(b.sequence));
        this.topics = list.map((t: any, i: number) => this.hydrateTopic(t, i));
        this.applyTopicFilter();
        this.loading = false;
        this.loadSavedYoutubeData();
        this.loadQuizBatchForTopics();
        if (!this.restoreScrollPosition()) {
          this.scrollToFocusedTopic();
        }
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

  /** Applies the combined status / assigned-to / document filters to `this.topics` -> `this.filteredTopics`. */
  applyTopicFilter() {
    let result = this.topics;

    if (this.statusFilter === 'final') {
      result = result.filter(t => t.topic_status === 'final');
    } else if (this.statusFilter === 'pre_final') {
      result = result.filter(t => t.topic_status === 'pre_final');
    } else if (this.statusFilter === 'pending') {
      result = result.filter(t => (t.topic_status || 'pending') === 'pending');
    }

    if (this.assignedFilter) {
      result = result.filter(t => String(t.assigned_to) === String(this.assignedFilter));
    }

    if (this.docFilter) {
      const docType = this.docFilter as SlideDocType;
      result = result.filter(t => this.slideDocAttached(t, docType));
    }

    this.filteredTopics = result;
  }

  onTopicFilterChange() { this.applyTopicFilter(); }

  /** Adds UI-only scaffolding (tracks placeholder, parsed screenshots array) onto a raw topic row. */
  private hydrateTopic(t: any, index?: number): any {
    let screenshots: string[] = [];
    if (t.screenshots) {
      try {
        const parsed = JSON.parse(t.screenshots);
        if (Array.isArray(parsed)) screenshots = parsed;
      } catch {
        // not JSON — ignore
      }
    }
    // mandir_assets comes decoded from the API as an object already (see
    // getTopicsByChapter/getAllTopics/getTopicById on the backend), but we
    // still guard here in case a row was loaded from an older cached
    // response or the field came back as a raw JSON string / null.
    let mandirAssets = t.mandir_assets;
    if (typeof mandirAssets === 'string') {
      try { mandirAssets = JSON.parse(mandirAssets); } catch { mandirAssets = null; }
    }
    if (!mandirAssets || typeof mandirAssets !== 'object') mandirAssets = {};
    mandirAssets = {
      city: '', state: '', time: '', dharmik_mahatva: '', darshan_time: '',
      pramukh_utsav: '', yatra_sujhav: '', pass_mein_dekhe: '',
      latitude: '', longitude: '',
      ...mandirAssets
    };

    return {
      ...t,
      topic_status: t.topic_status || 'pending',
      _screenshots: screenshots,
      mandir_assets: mandirAssets,
      // Pre-computed position within `this.topics`, used by the move
      // up/down buttons in the template instead of calling topicIndex(t)
      // (an O(n) findIndex scan) on every change-detection cycle for
      // every row. Kept in sync by reindexTopics() after any reorder.
      _index: index ?? 0,
      _tracks: TRACK_TYPES.reduce((acc, type) => {
        acc[type] = { status: 'empty', versions: [] };
        return acc;
      }, {} as any),
      // Quiz (QJ_) / Exercise (AJ_) question counts from the external quiz
      // API — null = not loaded yet, 0 = loaded with no questions pushed.
      quiz_total: null, quiz_approved: null, quiz_rejected: null, quiz_pending: null,
      exercise_total: null, exercise_approved: null, exercise_rejected: null, exercise_pending: null,
      yt: {
        desc: '',
        descState: 'none',
        guidancePrompt: '',
        thumb: {
          title: t.name || '',
          kicker: this.getDefaultKicker(t.topic_code),
          badge: 'VIDYAMINE',
          palette: 0,
          layout: 0,
          bgImage: null,
          bgImageUrl: null
        },
        thumbState: 'none'
      }
    };
  }

  /** Re-stamps `_index` on every topic to match its current position in
   *  `this.topics`. Call this after any operation that changes order,
   *  inserts, or removes topics (reorder, delete, bulk-delete, reload). */
  private reindexTopics() {
    this.topics.forEach((t, i) => t._index = i);
  }

  trackByTopicId(index: number, t: any): any {
    return t.id;
  }

  trackByScreenshot(index: number, s: string): any {
    return s;
  }

  private getDefaultKicker(topicCode?: string): string {
    if (topicCode) {
      const match = topicCode.match(/_0?(\d+)_20\d\d_/);
      if (match && match[1]) {
        return `CLASS ${match[1]} · MATHEMATICS`;
      }
    }
    return 'CLASS 8 · MATHEMATICS';
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
  // ADD TOPIC — "Add new topic" now opens a small chooser first:
  //   • Create by Screenshots — the existing pre-named-file import flow
  //   • Create Manually       — a blank topic row, auto-numbered/coded,
  //                             with only Name + Description (both optional)
  //                             left for the user to fill in right away.
  // ============================================================

  addTopicChooserOpen = false;

  openAddTopicChooser() {
    if (!this.chapter) {
      this.toast.error('Chapter not loaded yet');
      return;
    }
    this.addTopicChooserOpen = true;
  }

  closeAddTopicChooser() {
    this.addTopicChooserOpen = false;
  }

  /** Chooser option 1: hand off to the existing screenshot-import flow. */
  chooseCreateByScreenshots(pickerEl: HTMLInputElement) {
    this.addTopicChooserOpen = false;
    this.triggerImportPicker(pickerEl);
  }

  /** Chooser option 2: open the manual-create modal, pre-filled with the next topic no/code. */
  chooseCreateManually() {
    this.addTopicChooserOpen = false;
    this.openManualCreateModal();
  }

  // ── Screenshot import (existing flow) ──
  // Filenames on disk are expected as {NN}_{chapter_code}[_extra].ext
  // The picker allows multi-select; each selected file is parsed, checked
  // against this chapter's code, and grouped by topic number. Any mismatch
  // or gap surfaces a review panel before anything is sent to the server.

  triggerImportPicker(pickerEl: HTMLInputElement) {
    if (!this.chapter) {
      this.toast.error('Chapter not loaded yet');
      return;
    }
    pickerEl.value = '';
    pickerEl.click();
  }

  // ============================================================
  // MANUAL CREATE — adds one blank topic row without any screenshots.
  // The next topic number and its topic code ({NN}_{chapter_code}) are
  // computed automatically from the topics already in this chapter;
  // the user only ever needs to type a Name and/or Description, and
  // both of those are optional too — everything can be edited later
  // inline like any other topic.
  // ============================================================

  manualCreate: {
    open: boolean;
    topicNo: string;   // zero-padded, e.g. '09' — auto-computed, read-only
    topicCode: string; // '{topicNo}_{chapter_code}' — auto-computed, read-only
    name: string;
    description: string;
    submitting: boolean;
  } | null = null;

  /** Next topic number (1-based, zero-padded to 2 digits) based on the highest
   *  existing sequence/topic no. in this chapter — same numbering the
   *  screenshot-import flow uses, so both paths stay in sync. */
  private computeNextTopicNo(): string {
    const nos = this.topics
      .map(t => Number(t.sequence) || 0)
      .filter(n => !isNaN(n) && n > 0);
    const next = (nos.length ? Math.max(...nos) : this.topics.length) + 1;
    return String(next).padStart(2, '0');
  }

  openManualCreateModal() {
    if (!this.chapter) {
      this.toast.error('Chapter not loaded yet');
      return;
    }
    const chapterCode = (this.chapter?.chapter_code || '').trim();
    const topicNo = this.computeNextTopicNo();
    this.manualCreate = {
      open: true,
      topicNo,
      topicCode: `${topicNo}_${chapterCode}`,
      name: '',
      description: '',
      submitting: false
    };
  }

  closeManualCreateModal() {
    this.manualCreate = null;
  }

  submitManualCreate() {
    if (!this.manualCreate || !this.chapter) return;
    this.manualCreate.submitting = true;

    // Reuses the existing POST /topics -> createTopic() endpoint (same one
    // the rest of the admin already has). It wants `sequence` as a number
    // and doesn't have a separate "topic_no" field of its own — topicNo is
    // just the zero-padded display form of that same sequence number.
    const payload = {
      chapter_id: this.chapterId,
      topic_code: this.manualCreate.topicCode,
      sequence: parseInt(this.manualCreate.topicNo, 10) || undefined,
      name: (this.manualCreate.name || '').trim(),
      description: (this.manualCreate.description || '').trim()
    };

    this.api.post<any>('/topics', payload).subscribe({
      next: (r: any) => {
        if (this.manualCreate) this.manualCreate.submitting = false;
        if (r?.status) {
          this.toast.success(`Topic ${this.manualCreate?.topicNo} created`);
          this.closeManualCreateModal();
          this.load();
        } else {
          this.toast.error(r?.message || 'Failed to create topic');
        }
      },
      error: (err: any) => {
        if (this.manualCreate) this.manualCreate.submitting = false;
        this.toast.error(err?.error?.message || 'Failed to create topic');
      }
    });
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

    // Any file that failed to parse or doesn't match this chapter's code —
    // flag it audibly so the person doesn't have to spot it visually first.
    if (items.some(it => !it.resolved)) {
      this.playAttachWarningSound();
    }
  }

  /** Plays warning.mp3 once whenever an attach flow detects a problem — a
   *  mismatched/unparseable filename or an oversized file. Used across the
   *  screenshot import review, Slide/Script/Audio/Quiz-Exercise attach
   *  modals. Best-effort — browsers can block autoplay before any user
   *  gesture, so failures are swallowed silently rather than surfaced. */
  private playAttachWarningSound() {
    try {
      const audio = new Audio('sounds/wrongfile.mp3');
      audio.play().catch(() => { /* autoplay blocked or file missing — ignore */ });
    } catch {
      // ignore — sound is a nice-to-have, never block the UI on it
    }
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
  // DESCRIPTION — inline (table cell, blur-to-save) + modal editor
  // ============================================================

  /** Inline save, mirrors saveCaption() — fires on blur from the table cell textarea. */
  saveTopicDescription(t: any) {
    if (!t.id) return;
    this.savingDescription[t.id] = true;
    this.api.put<any>(`/topics/${t.id}/description`, { description: t.description || '' }).subscribe({
      next: (r: any) => {
        this.savingDescription[t.id] = false;
        if (!r?.status) this.toast.error(r?.message || 'Failed to save description');
      },
      error: () => {
        this.savingDescription[t.id] = false;
        this.toast.error('Failed to save description');
      }
    });
  }

  openDescriptionModal(t: any) {
    this.descriptionModal = { open: true, topic: t, textInput: t.description || '' };
  }

  closeDescriptionModal() {
    this.descriptionModal = { open: false, topic: null, textInput: '' };
  }

  confirmDescriptionModal() {
    const t = this.descriptionModal.topic;
    if (!t || !t.id) return;
    const value = this.descriptionModal.textInput || '';
    this.savingDescription[t.id] = true;
    this.api.put<any>(`/topics/${t.id}/description`, { description: value }).subscribe({
      next: (r: any) => {
        this.savingDescription[t.id] = false;
        if (r?.status) {
          t.description = value;
          this.toast.success('Description saved');
          this.closeDescriptionModal();
        } else {
          this.toast.error(r?.message || 'Failed to save description');
        }
      },
      error: (err: any) => {
        this.savingDescription[t.id] = false;
        this.toast.error(err?.error?.message || 'Failed to save description');
      }
    });
  }

  deleteTopicDescription(t: any) {
    if (!t || !t.id) return;
    this.savingDescription[t.id] = true;
    this.api.delete<any>(`/topics/${t.id}/description`).subscribe({
      next: (r: any) => {
        this.savingDescription[t.id] = false;
        if (r?.status) {
          t.description = null;
          if (this.descriptionModal.topic === t) this.descriptionModal.textInput = '';
          this.toast.success('Description removed');
        } else {
          this.toast.error(r?.message || 'Failed to remove description');
        }
      },
      error: (err: any) => {
        this.savingDescription[t.id] = false;
        this.toast.error(err?.error?.message || 'Failed to remove description');
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
    this.reindexTopics();
    this.persistReorder();
  }

  /** Real index of a topic within the unfiltered `this.topics` array.
   *  Prefer the pre-computed `t._index` in the template — this remains
   *  only for any non-template callers that need a fresh, guaranteed-
   *  correct lookup. */
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
    const jsonDocType = TRACK_TO_JSON_DOC[type];
    if (!jsonDocType) {
      this.toast.success(`Attach (${TRACK_LABEL[type]}) — coming soon`);
      return;
    }
    this.openJsonDocModal(t, jsonDocType);
  }

  /** Opens the Attach popup for the Purified Quiz JSON (PQ_) — second button in the Quiz card, alongside the regular Quiz JSON (QJ_) attach. */
  trackAttachPurified(t: any) {
    this.openJsonDocModal(t, 'quiz_purified');
  }

  // ============================================================
  // QUIZ / EXERCISE JSON ATTACHMENTS
  // Single slot each, saved to the same server folder as the Slide docs
  // (/topic_attachments). Required filename: {prefix}{topic_code}.json
  // — QJ_ for quiz, AJ_ for exercise — enforced client + server side.
  // Same popup-card UX as the Slide-doc modal: view stage (preview +
  // download/replace/delete) when attached, upload stage (pick file,
  // mismatch → rename & continue) when not.
  // ============================================================

  /** Modal state for the currently open Quiz/Exercise JSON popup (null = closed). */
  jsonDocModal: {
    topic: any;
    def: JsonDocDef;
    stage: 'view' | 'upload';
    pickedFile: File | null;
    pickedName: string;   // basename (no ext) of the picked file, for the mismatch check
    pickedExt: string;
    nameMatches: boolean;
    sizeError: string;
    uploading: boolean;
    deleting: boolean;
  } | null = null;

  /** True if this topic already has a file saved for the given JSON doc type. */
  /** Resolves a track tile type (quiz/exer/script) to its JsonDocType, or null for tiles without one (slide/youtube). */
  trackJsonDocType(type: TrackType): JsonDocType | null {
    return TRACK_TO_JSON_DOC[type] ?? null;
  }

  jsonDocAttached(t: any, docType: JsonDocType): boolean {
    const def = JSON_DOC_DEFS[docType];
    return !!(t && t[def.field]);
  }

  jsonDocFilename(t: any, docType: JsonDocType): string {
    const def = JSON_DOC_DEFS[docType];
    return t ? (t[def.field] || '') : '';
  }

  jsonDocUrl(filename: string): string {
    if (!filename) return '';
    return `${this.ATTACH_BASE}/${filename}`;
  }

  /** Sanitized version of jsonDocUrl() for use in an iframe [src] binding (JSON pretty-preview). */
  jsonDocSafeUrl(filename: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.jsonDocUrl(filename));
  }

  private jsonUploadKey(t: any, docType: JsonDocType): string {
    return `${t?.id}_${docType}`;
  }

  isUploadingJsonDoc(t: any, docType: JsonDocType): boolean {
    return !!this.uploadingJsonDoc[this.jsonUploadKey(t, docType)];
  }

  /** Expected filename base (no extension) for a given topic + JSON doc type. */
  expectedJsonDocBase(t: any, def: JsonDocDef): string {
    return `${def.prefix}${t.topic_code}`;
  }

  /** Opens the popup for a Quiz/Exercise Attach button — lands straight on 'view' if attached, else 'upload'. */
  openJsonDocModal(t: any, docType: JsonDocType) {
    const def = JSON_DOC_DEFS[docType];
    this.jsonDocModal = {
      topic: t,
      def,
      stage: this.jsonDocAttached(t, docType) ? 'view' : 'upload',
      pickedFile: null,
      pickedName: '',
      pickedExt: '',
      nameMatches: false,
      sizeError: '',
      uploading: false,
      deleting: false
    };
  }

  closeJsonDocModal() {
    this.jsonDocModal = null;
  }

  /** Switches the modal into "replace" (upload) mode. */
  jsonDocSwitchToUpload() {
    if (!this.jsonDocModal) return;
    this.jsonDocModal.stage = 'upload';
    this.jsonDocModal.pickedFile = null;
    this.jsonDocModal.pickedName = '';
    this.jsonDocModal.pickedExt = '';
    this.jsonDocModal.nameMatches = false;
    this.jsonDocModal.sizeError = '';
  }

  jsonDocBackToView() {
    if (!this.jsonDocModal) return;
    this.jsonDocModal.stage = 'view';
    this.jsonDocModal.pickedFile = null;
  }

  triggerJsonDocPicker(fileInput: HTMLInputElement) {
    fileInput.click();
  }

  /** Runs when a file is chosen in the upload stage — validates name & size, no upload yet. */
  onJsonDocFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.jsonDocModal) return;

    const dot = file.name.lastIndexOf('.');
    const base = dot !== -1 ? file.name.substring(0, dot) : file.name;
    const ext = dot !== -1 ? file.name.substring(dot + 1).toLowerCase() : '';

    const m = this.jsonDocModal;
    const expectedBase = this.expectedJsonDocBase(m.topic, m.def);
    const extOk = m.def.exts.includes(ext);

    const maxBytes = this.MAX_JSON_DOC_MB * 1024 * 1024;
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);

    m.pickedFile = file;
    m.pickedName = base;
    m.pickedExt = ext;
    m.nameMatches = (base.toLowerCase() === expectedBase.toLowerCase()) && extOk;
    m.sizeError = file.size > maxBytes
      ? `This file is ${fileSizeMb} MB. Max allowed size is ${this.MAX_JSON_DOC_MB} MB — please choose a smaller file.`
      : '';
    if (!m.nameMatches || m.sizeError) this.playAttachWarningSound();
  }

  /** User clicks "Rename & Continue" on a mismatched file — renames it in-memory to the expected name.
   *  Keeps the picked file's own extension if it's an allowed one for this doc type (e.g. Script accepts
   *  both .doc and .docx); otherwise falls back to the doc type's first allowed extension. */
  jsonDocFixName() {
    if (!this.jsonDocModal || !this.jsonDocModal.pickedFile) return;
    const m = this.jsonDocModal;
    const originalFile = m.pickedFile!;
    const expectedBase = this.expectedJsonDocBase(m.topic, m.def);
    const fixedExt = m.def.exts.includes(m.pickedExt) ? m.pickedExt : m.def.exts[0];
    const fixedName = `${expectedBase}.${fixedExt}`;

    const renamed = new File([originalFile], fixedName, { type: originalFile.type || '' });

    m.pickedFile = renamed;
    m.pickedName = expectedBase;
    m.pickedExt = fixedExt;
    m.nameMatches = true;
  }

  jsonDocCancelPickedFile() {
    if (!this.jsonDocModal) return;
    this.jsonDocModal.pickedFile = null;
    this.jsonDocModal.pickedName = '';
    this.jsonDocModal.pickedExt = '';
    this.jsonDocModal.nameMatches = false;
    this.jsonDocModal.sizeError = '';
  }

  /** Confirms upload — only enabled once nameMatches is true and file is within the size limit. */
  confirmJsonDocUpload() {
    const m = this.jsonDocModal;
    if (!m || !m.pickedFile || !m.nameMatches || m.uploading) return;
    if (m.sizeError) {
      this.toast.error(m.sizeError);
      return;
    }

    const fileToUpload = m.pickedFile;
    const t = m.topic;
    const def = m.def;
    const key = this.jsonUploadKey(t, def.type);

    m.uploading = true;
    this.uploadingJsonDoc[key] = true;

    const formData = new FormData();
    formData.append('file', fileToUpload, fileToUpload.name);
    formData.append('topic_id', String(t.id));
    formData.append('doc_type', def.type);

    this.api.post<any>('/topics/upload-json-doc', formData).subscribe({
      next: (r: any) => {
        if (m) m.uploading = false;
        this.uploadingJsonDoc[key] = false;
        if (r?.status) {
          t[def.field] = r.filename;
          this.toast.success(`${def.label} attached`);
          m.stage = 'view';
          m.pickedFile = null;
        } else {
          this.toast.error(this.jsonDocUploadErrorMessage(r?.message, fileToUpload, 0));
        }
      },
      error: (e: any) => {
        if (m) m.uploading = false;
        this.uploadingJsonDoc[key] = false;
        this.toast.error(this.jsonDocUploadErrorMessage(e?.error?.message, fileToUpload, e?.status));
      }
    });
  }

  /** Builds a clear, user-facing message for JSON-doc upload failures, calling out oversize files specifically. */
  private jsonDocUploadErrorMessage(serverMessage: string | undefined, file: File, httpStatus: number): string {
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const looksLikeSizeIssue =
      httpStatus === 413 ||
      /too large|payload|max.*size|filesize|file size|exceeds/i.test(serverMessage || '');

    if (looksLikeSizeIssue) {
      return `This file is ${fileSizeMb} MB, which is larger than the server's ${this.MAX_JSON_DOC_MB} MB upload limit. Please choose a smaller file.`;
    }
    return serverMessage || 'Upload failed';
  }

  /** Removes the attached Quiz/Exercise JSON file from a topic. */
  deleteJsonDoc() {
    const m = this.jsonDocModal;
    if (!m || m.deleting) return;
    if (!confirm(`Remove ${m.def.label} from this topic? This deletes the file from the server.`)) return;

    const t = m.topic;
    const def = m.def;
    const key = this.jsonUploadKey(t, def.type);

    m.deleting = true;
    this.uploadingJsonDoc[key] = true;

    this.api.post<any>(`/topics/${t.id}/delete-json-doc`, { doc_type: def.type }).subscribe({
      next: (r: any) => {
        if (m) m.deleting = false;
        this.uploadingJsonDoc[key] = false;
        if (r?.status) {
          t[def.field] = null;
          this.toast.success(`${def.label} removed`);
          if (m) m.stage = 'upload';
        } else {
          this.toast.error(r?.message || 'Delete failed');
        }
      },
      error: (e: any) => {
        if (m) m.deleting = false;
        this.uploadingJsonDoc[key] = false;
        this.toast.error(e?.error?.message || 'Delete failed');
      }
    });
  }

  /** Downloads the attached JSON file for the modal's active topic/docType. */
  downloadJsonDocFilename(filename: string) {
    if (!filename) return;
    const url = this.jsonDocUrl(filename);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============================================================
  // AUDIO ATTACHMENT (Audio tile, right after YouTube)
  // Single slot, saved to its own server folder (/topic_audios), DB column
  // `audio_file`. Required filename: {LA_|PA_|SA_}{topic_code}.{mp3|wav|m4a|ogg}
  // — enforced client + server. Same popup-card UX as Quiz/Exercise/Script:
  // view stage (inline <audio> player + download/replace/delete) when
  // attached, upload stage (pick file, mismatch -> rename & continue) when not.
  // ============================================================

  private uploadingAudio: Record<number, boolean> = {};

  /** The single <audio> element currently allowed to play — every other
   *  audio element (tile mini-players + the modal player) gets paused
   *  when a new one starts, so only one topic's audio plays at a time. */
  private currentlyPlayingAudio: HTMLAudioElement | null = null;

  /** Bound to (play) on every <audio> element for the Audio tile/modal.
   *  Pauses whatever was previously playing before letting this one continue. */
  onAudioPlay(event: Event) {
    const el = event.target as HTMLAudioElement;
    if (this.currentlyPlayingAudio && this.currentlyPlayingAudio !== el) {
      this.currentlyPlayingAudio.pause();
    }
    this.currentlyPlayingAudio = el;
  }

  /** Modal state for the currently open Audio popup (null = closed). */
  audioModal: {
    topic: any;
    stage: 'view' | 'upload';
    pickedFile: File | null;
    pickedName: string;
    pickedExt: string;
    nameMatches: boolean;
    sizeError: string;
    uploading: boolean;
    deleting: boolean;
  } | null = null;

  audioAttached(t: any): boolean {
    return !!(t && t[AUDIO_FIELD]);
  }

  audioFilename(t: any): string {
    return t ? (t[AUDIO_FIELD] || '') : '';
  }

  audioUrl(filename: string): string {
    if (!filename) return '';
    return `${this.AUDIO_BASE}/${filename}`;
  }

  isUploadingAudio(t: any): boolean {
    return !!this.uploadingAudio[t?.id];
  }

  /** Default expected filename base (no extension) shown as the "Rename & Continue" target. */
  expectedAudioBase(t: any): string {
    return `${AUDIO_PREFIX}${t.topic_code}`;
  }

  /** All accepted filename bases (no extension), e.g. ["LA_01_...", "PA_01_...", "SA_01_..."] — for the "Required filename" hint. */
  expectedAudioBases(t: any): string[] {
    return AUDIO_PREFIXES.map(p => `${p}${t.topic_code}`);
  }

  /** True if `base` matches ANY of the accepted prefixes + this topic's code (case-insensitive). */
  private audioBaseMatchesAnyPrefix(base: string, t: any): boolean {
    const lower = base.toLowerCase();
    return AUDIO_PREFIXES.some(p => lower === `${p}${t.topic_code}`.toLowerCase());
  }

  /** Opens the Audio popup — lands on 'view' if attached, else 'upload'. */
  openAudioModal(t: any) {
    this.audioModal = {
      topic: t,
      stage: this.audioAttached(t) ? 'view' : 'upload',
      pickedFile: null,
      pickedName: '',
      pickedExt: '',
      nameMatches: false,
      sizeError: '',
      uploading: false,
      deleting: false
    };
  }

  closeAudioModal() {
    this.audioModal = null;
  }

  audioSwitchToUpload() {
    if (!this.audioModal) return;
    this.audioModal.stage = 'upload';
    this.audioModal.pickedFile = null;
    this.audioModal.pickedName = '';
    this.audioModal.pickedExt = '';
    this.audioModal.nameMatches = false;
    this.audioModal.sizeError = '';
  }

  audioBackToView() {
    if (!this.audioModal) return;
    this.audioModal.stage = 'view';
    this.audioModal.pickedFile = null;
  }

  triggerAudioPicker(fileInput: HTMLInputElement) {
    fileInput.click();
  }

  /** Runs when a file is chosen in the upload stage — validates name & size, no upload yet. */
  onAudioFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.audioModal) return;

    const dot = file.name.lastIndexOf('.');
    const base = dot !== -1 ? file.name.substring(0, dot) : file.name;
    const ext = dot !== -1 ? file.name.substring(dot + 1).toLowerCase() : '';

    const m = this.audioModal;
    const extOk = AUDIO_EXTS.includes(ext);

    const maxBytes = this.MAX_AUDIO_MB * 1024 * 1024;
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);

    m.pickedFile = file;
    m.pickedName = base;
    m.pickedExt = ext;
    m.nameMatches = this.audioBaseMatchesAnyPrefix(base, m.topic) && extOk;
    m.sizeError = file.size > maxBytes
      ? `This file is ${fileSizeMb} MB. Max allowed size is ${this.MAX_AUDIO_MB} MB — please choose a smaller file.`
      : '';
    if (!m.nameMatches || m.sizeError) this.playAttachWarningSound();
  }

  /** User clicks "Rename & Continue" on a mismatched file — renames it in-memory to the expected name. */
  audioFixName() {
    if (!this.audioModal || !this.audioModal.pickedFile) return;
    const m = this.audioModal;
    const originalFile = m.pickedFile!;
    const expectedBase = this.expectedAudioBase(m.topic);
    const fixedExt = AUDIO_EXTS.includes(m.pickedExt) ? m.pickedExt : AUDIO_EXTS[0];
    const fixedName = `${expectedBase}.${fixedExt}`;

    const renamed = new File([originalFile], fixedName, { type: originalFile.type || '' });

    m.pickedFile = renamed;
    m.pickedName = expectedBase;
    m.pickedExt = fixedExt;
    m.nameMatches = true;
  }

  audioCancelPickedFile() {
    if (!this.audioModal) return;
    this.audioModal.pickedFile = null;
    this.audioModal.pickedName = '';
    this.audioModal.pickedExt = '';
    this.audioModal.nameMatches = false;
    this.audioModal.sizeError = '';
  }

  /** Confirms upload — only enabled once nameMatches is true and file is within the size limit. */
  confirmAudioUpload() {
    const m = this.audioModal;
    if (!m || !m.pickedFile || !m.nameMatches || m.uploading) return;
    if (m.sizeError) {
      this.toast.error(m.sizeError);
      return;
    }

    const fileToUpload = m.pickedFile;
    const t = m.topic;

    m.uploading = true;
    this.uploadingAudio[t.id] = true;

    const formData = new FormData();
    formData.append('file', fileToUpload, fileToUpload.name);
    formData.append('topic_id', String(t.id));

    this.api.post<any>('/topics/upload-audio', formData).subscribe({
      next: (r: any) => {
        if (m) m.uploading = false;
        this.uploadingAudio[t.id] = false;
        if (r?.status) {
          t[AUDIO_FIELD] = r.filename;
          this.toast.success(`${AUDIO_LABEL} attached`);
          m.stage = 'view';
          m.pickedFile = null;
        } else {
          this.toast.error(this.audioUploadErrorMessage(r?.message, fileToUpload, 0));
        }
      },
      error: (e: any) => {
        if (m) m.uploading = false;
        this.uploadingAudio[t.id] = false;
        this.toast.error(this.audioUploadErrorMessage(e?.error?.message, fileToUpload, e?.status));
      }
    });
  }

  private audioUploadErrorMessage(serverMessage: string | undefined, file: File, httpStatus: number): string {
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const looksLikeSizeIssue =
      httpStatus === 413 ||
      /too large|payload|max.*size|filesize|file size|exceeds/i.test(serverMessage || '');

    if (looksLikeSizeIssue) {
      return `This file is ${fileSizeMb} MB, which is larger than the server's ${this.MAX_AUDIO_MB} MB upload limit. Please choose a smaller file.`;
    }
    return serverMessage || 'Upload failed';
  }

  /** Removes the attached Audio file from a topic. */
  deleteAudio() {
    const m = this.audioModal;
    if (!m || m.deleting) return;
    if (!confirm(`Remove ${AUDIO_LABEL} from this topic? This deletes the file from the server.`)) return;

    const t = m.topic;
    m.deleting = true;
    this.uploadingAudio[t.id] = true;

    this.api.post<any>(`/topics/${t.id}/delete-audio`, {}).subscribe({
      next: (r: any) => {
        if (m) m.deleting = false;
        this.uploadingAudio[t.id] = false;
        if (r?.status) {
          t[AUDIO_FIELD] = null;
          this.toast.success(`${AUDIO_LABEL} removed`);
          if (m) m.stage = 'upload';
        } else {
          this.toast.error(r?.message || 'Delete failed');
        }
      },
      error: (e: any) => {
        if (m) m.deleting = false;
        this.uploadingAudio[t.id] = false;
        this.toast.error(e?.error?.message || 'Delete failed');
      }
    });
  }

  /** Downloads the attached audio file for the modal's active topic. */
  downloadAudioFilename(filename: string) {
    if (!filename) return;
    const url = this.audioUrl(filename);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============================================================
  // TOPIC FILE ("Attach file" button next to Screenshots)
  // Single slot, ANY extension allowed. Saved to the SAME server folder
  // as Screenshots (/Screenshots), DB column `topic_doc`.
  // Required filename: TF_{topic_code}.{ext} — enforced client + server.
  // Same popup-card UX as the Slide/JSON-doc modals: view stage (filename
  // + download/replace/delete) when attached, upload stage (pick file,
  // mismatch → rename & continue) when not.
  // ============================================================

  /** Modal state for the currently open Topic File popup (null = closed). */
  topicDocModal: {
    topic: any;
    stage: 'view' | 'upload';
    pickedFile: File | null;
    pickedName: string;   // basename (no ext) of the picked file, for the mismatch check
    pickedExt: string;
    nameMatches: boolean;
    sizeError: string;
    uploading: boolean;
    deleting: boolean;
  } | null = null;

  /** True if this topic already has a Topic File saved. */
  topicDocAttached(t: any): boolean {
    return !!(t && t[TOPIC_DOC_FIELD]);
  }

  topicDocFilename(t: any): string {
    return t ? (t[TOPIC_DOC_FIELD] || '') : '';
  }

  /** Topic File lives in the same folder as screenshots. */
  topicDocUrl(filename: string): string {
    if (!filename) return '';
    return `${this.SCREENSHOT_BASE}/${filename}`;
  }

  isUploadingTopicDoc(t: any): boolean {
    return !!this.uploadingTopicDoc[t?.id];
  }

  /** Expected filename base (no extension): TF_{topic_code}. */
  expectedTopicDocBase(t: any): string {
    return `${TOPIC_DOC_PREFIX}${t.topic_code}`;
  }

  /** Opens the popup for the Attach-file button — lands on 'view' if attached, else 'upload'. */
  openTopicDocModal(t: any) {
    this.topicDocModal = {
      topic: t,
      stage: this.topicDocAttached(t) ? 'view' : 'upload',
      pickedFile: null,
      pickedName: '',
      pickedExt: '',
      nameMatches: false,
      sizeError: '',
      uploading: false,
      deleting: false
    };
  }

  closeTopicDocModal() {
    this.topicDocModal = null;
  }

  /** Switches the modal into "replace" (upload) mode. */
  topicDocSwitchToUpload() {
    if (!this.topicDocModal) return;
    this.topicDocModal.stage = 'upload';
    this.topicDocModal.pickedFile = null;
    this.topicDocModal.pickedName = '';
    this.topicDocModal.pickedExt = '';
    this.topicDocModal.nameMatches = false;
    this.topicDocModal.sizeError = '';
  }

  topicDocBackToView() {
    if (!this.topicDocModal) return;
    this.topicDocModal.stage = 'view';
    this.topicDocModal.pickedFile = null;
  }

  triggerTopicDocPicker(fileInput: HTMLInputElement) {
    fileInput.click();
  }

  /** Runs when a file is chosen in the upload stage — validates name & size, no upload yet. Any extension is accepted, as long as the base name matches. */
  onTopicDocFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.topicDocModal) return;

    const dot = file.name.lastIndexOf('.');
    const base = dot !== -1 ? file.name.substring(0, dot) : file.name;
    const ext = dot !== -1 ? file.name.substring(dot + 1) : '';

    const m = this.topicDocModal;
    const expectedBase = this.expectedTopicDocBase(m.topic);

    const maxBytes = this.MAX_TOPIC_DOC_MB * 1024 * 1024;
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);

    m.pickedFile = file;
    m.pickedName = base;
    m.pickedExt = ext;
    m.nameMatches = (base.toLowerCase() === expectedBase.toLowerCase()) && ext !== '';
    m.sizeError = file.size > maxBytes
      ? `This file is ${fileSizeMb} MB. Max allowed size is ${this.MAX_TOPIC_DOC_MB} MB — please choose a smaller file.`
      : '';
    if (!m.nameMatches || m.sizeError) this.playAttachWarningSound();
  }

  /** User clicks "Rename & Continue" on a mismatched file — renames it in-memory to the expected name, keeping its original extension. */
  topicDocFixName() {
    if (!this.topicDocModal || !this.topicDocModal.pickedFile) return;
    const m = this.topicDocModal;
    const originalFile = m.pickedFile!;
    const expectedBase = this.expectedTopicDocBase(m.topic);
    const ext = m.pickedExt || 'dat';
    const fixedName = `${expectedBase}.${ext}`;

    const renamed = new File([originalFile], fixedName, { type: originalFile.type });

    m.pickedFile = renamed;
    m.pickedName = expectedBase;
    m.pickedExt = ext;
    m.nameMatches = true;
  }

  topicDocCancelPickedFile() {
    if (!this.topicDocModal) return;
    this.topicDocModal.pickedFile = null;
    this.topicDocModal.pickedName = '';
    this.topicDocModal.pickedExt = '';
    this.topicDocModal.nameMatches = false;
    this.topicDocModal.sizeError = '';
  }

  /** Confirms upload — only enabled once nameMatches is true and file is within the size limit. */
  confirmTopicDocUpload() {
    const m = this.topicDocModal;
    if (!m || !m.pickedFile || !m.nameMatches || m.uploading) return;
    if (m.sizeError) {
      this.toast.error(m.sizeError);
      return;
    }

    const fileToUpload = m.pickedFile;
    const t = m.topic;

    m.uploading = true;
    this.uploadingTopicDoc[t.id] = true;

    const formData = new FormData();
    formData.append('file', fileToUpload, fileToUpload.name);
    formData.append('topic_id', String(t.id));

    this.api.post<any>('/topics/upload-topic-doc', formData).subscribe({
      next: (r: any) => {
        if (m) m.uploading = false;
        this.uploadingTopicDoc[t.id] = false;
        if (r?.status) {
          t[TOPIC_DOC_FIELD] = r.filename;
          this.toast.success(`${TOPIC_DOC_LABEL} attached`);
          m.stage = 'view';
          m.pickedFile = null;
        } else {
          this.toast.error(this.topicDocUploadErrorMessage(r?.message, fileToUpload, 0));
        }
      },
      error: (e: any) => {
        if (m) m.uploading = false;
        this.uploadingTopicDoc[t.id] = false;
        this.toast.error(this.topicDocUploadErrorMessage(e?.error?.message, fileToUpload, e?.status));
      }
    });
  }

  /** Builds a clear, user-facing message for Topic File upload failures, calling out oversize files specifically. */
  private topicDocUploadErrorMessage(serverMessage: string | undefined, file: File, httpStatus: number): string {
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const looksLikeSizeIssue =
      httpStatus === 413 ||
      /too large|payload|max.*size|filesize|file size|exceeds/i.test(serverMessage || '');

    if (looksLikeSizeIssue) {
      return `This file is ${fileSizeMb} MB, which is larger than the server's ${this.MAX_TOPIC_DOC_MB} MB upload limit. Please choose a smaller file.`;
    }
    return serverMessage || 'Upload failed';
  }

  /** Removes the attached Topic File from a topic. */
  deleteTopicDoc() {
    const m = this.topicDocModal;
    if (!m || m.deleting) return;
    if (!confirm(`Remove ${TOPIC_DOC_LABEL} from this topic? This deletes the file from the server.`)) return;

    const t = m.topic;

    m.deleting = true;
    this.uploadingTopicDoc[t.id] = true;

    this.api.post<any>(`/topics/${t.id}/delete-topic-doc`, {}).subscribe({
      next: (r: any) => {
        if (m) m.deleting = false;
        this.uploadingTopicDoc[t.id] = false;
        if (r?.status) {
          t[TOPIC_DOC_FIELD] = null;
          this.toast.success(`${TOPIC_DOC_LABEL} removed`);
          if (m) m.stage = 'upload';
        } else {
          this.toast.error(r?.message || 'Delete failed');
        }
      },
      error: (e: any) => {
        if (m) m.deleting = false;
        this.uploadingTopicDoc[t.id] = false;
        this.toast.error(e?.error?.message || 'Delete failed');
      }
    });
  }

  /** Downloads the attached Topic File for the modal's active topic. */
  downloadTopicDocFilename(filename: string) {
    if (!filename) return;
    const url = this.topicDocUrl(filename);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ============================================================
  // SLIDE-TILE DOCUMENTS (Claude PPT / ChatGPT PPT / Claude PDF)
  // Each doc type has 6 slots: Original + Version 1-5. Saves to server
  // folder /topic_attachments, filename must be exactly
  // {topic_code}{suffix}.{ext} (suffix gets _V1.._V5 appended for
  // version slots) — enforced client + server side.
  // ============================================================

  /** True if this topic already has a file saved for the given slot. */
  slideSlotAttached(t: any, slot: SlideDocSlot): boolean {
    return !!(t && t[slot.field]);
  }

  slideSlotFilename(t: any, slot: SlideDocSlot): string {
    return t ? (t[slot.field] || '') : '';
  }

  /** True if this topic has ANY file (original or any version) for the doc type — drives the Slide tile's summary chip. */
  slideDocAttached(t: any, docType: SlideDocType): boolean {
    const def = SLIDE_DOC_DEFS[docType];
    return slideDocSlots(def).some(slot => this.slideSlotAttached(t, slot));
  }

  slideDocFilename(t: any, docType: SlideDocType): string {
    const def = SLIDE_DOC_DEFS[docType];
    return t ? (t[def.field] || '') : '';
  }

  /** How many slots (out of 6) are filled for this doc type — e.g. "2/6". */
  slideDocFilledCount(t: any, docType: SlideDocType): number {
    const def = SLIDE_DOC_DEFS[docType];
    return slideDocSlots(def).filter(slot => this.slideSlotAttached(t, slot)).length;
  }

  /** Builds the single Final or Self slot for a doc type (no versions, unlike Production). */
  slideDocSingleSlot(docType: SlideDocType, tier: 'final' | 'self'): SlideDocSlot {
    const def = SLIDE_DOC_DEFS[docType];
    return tier === 'final' ? slideDocFinalSlot(def) : slideDocSelfSlot(def);
  }

  /** True if this topic has a file in the Final or Self slot for the given doc type. */
  slideDocAttachedTier(t: any, docType: SlideDocType, tier: 'final' | 'self'): boolean {
    const slot = this.slideDocSingleSlot(docType, tier);
    return this.slideSlotAttached(t, slot);
  }

  slideDocFilenameTier(t: any, docType: SlideDocType, tier: 'final' | 'self'): string {
    const slot = this.slideDocSingleSlot(docType, tier);
    return this.slideSlotFilename(t, slot);
  }

  slideDocUrl(filename: string): string {
    if (!filename) return '';
    return `${this.ATTACH_BASE}/${filename}`;
  }

  /** Sanitized version of slideDocUrl() for use in an iframe [src] binding. */
  slideDocSafeUrl(filename: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(this.slideDocUrl(filename));
  }

  /** Expected filename base (no extension) for a given topic + slot. */
  expectedSlotBase(t: any, slot: SlideDocSlot): string {
    return `${t.topic_code}${slot.suffix}`;
  }

  /** Opens the popup for a Slide-tile doc button.
   *  - Production (default): lands on the slot picker (Original/v1..v5).
   *  - Final / Self: single slot only, so skip the picker and go straight
   *    to 'view' (if already attached) or 'upload'. */
  openSlideDocModal(t: any, docType: SlideDocType, tier: SlideTier = 'production') {
    const def = SLIDE_DOC_DEFS[docType];

    if (tier === 'production') {
      const slots = slideDocSlots(def);
      this.slideDocModal = {
        topic: t,
        def,
        slots,
        activeSlot: slots[0],
        stage: 'picker',
        pickedFile: null,
        pickedName: '',
        pickedExt: '',
        nameMatches: false,
        sizeError: '',
        uploading: false,
        deleting: false,
        safeUrl: null
      };
      return;
    }

    // Final / Self — one slot, no picker.
    const slot = tier === 'final' ? slideDocFinalSlot(def) : slideDocSelfSlot(def);
    const stage = this.slideSlotAttached(t, slot) ? 'view' : 'upload';
    this.slideDocModal = {
      topic: t,
      def,
      slots: [slot],
      activeSlot: slot,
      stage,
      pickedFile: null,
      pickedName: '',
      pickedExt: '',
      nameMatches: false,
      sizeError: '',
      uploading: false,
      deleting: false,
      safeUrl: null
    };
    if (stage === 'view') this.refreshSlideDocSafeUrl();
  }

  /** Computes and caches the sanitized iframe URL for the active slot ONCE,
   *  so the [src] binding stays a stable object reference and the iframe
   *  doesn't reload/flicker on every change-detection cycle (mousemove etc).
   *  Call this only when entering the 'view' stage — never from the template. */
  private refreshSlideDocSafeUrl() {
    if (!this.slideDocModal) return;
    const isPdf = this.slideDocModal.def.type === 'claude_pdf' || this.slideDocModal.def.type === 'gpt_pdf';
    if (!isPdf) {
      this.slideDocModal.safeUrl = null;
      return;
    }
    const filename = this.slideSlotFilename(this.slideDocModal.topic, this.slideDocModal.activeSlot);
    this.slideDocModal.safeUrl = filename ? this.slideDocSafeUrl(filename) : null;
  }

  closeSlideDocModal() {
    this.slideDocModal = null;
  }

  /** From the picker, choose a slot: goes to 'view' if it already has a file, else straight to 'upload'. */
  slideDocChooseSlot(slot: SlideDocSlot) {
    if (!this.slideDocModal) return;
    const m = this.slideDocModal;
    m.activeSlot = slot;
    m.pickedFile = null;
    m.pickedName = '';
    m.pickedExt = '';
    m.nameMatches = false;
    m.sizeError = '';
    m.stage = this.slideSlotAttached(m.topic, slot) ? 'view' : 'upload';
    if (m.stage === 'view') this.refreshSlideDocSafeUrl();
  }

  /** Back out of view/upload to the slot picker list. Final/Self have no picker (single slot) — no-op there. */
  slideDocBackToPicker() {
    if (!this.slideDocModal) return;
    if (this.slideDocModal.activeSlot.tier !== 'production') return;
    this.slideDocModal.stage = 'picker';
    this.slideDocModal.pickedFile = null;
  }

  /** Switches the active slot's modal into "replace" (upload) mode. */
  slideDocSwitchToUpload() {
    if (!this.slideDocModal) return;
    this.slideDocModal.stage = 'upload';
    this.slideDocModal.pickedFile = null;
    this.slideDocModal.pickedName = '';
    this.slideDocModal.pickedExt = '';
    this.slideDocModal.nameMatches = false;
    this.slideDocModal.sizeError = '';
  }

  slideDocBackToView() {
    if (!this.slideDocModal) return;
    this.slideDocModal.stage = 'view';
    this.slideDocModal.pickedFile = null;
    this.refreshSlideDocSafeUrl();
  }

  triggerSlideDocPicker(fileInput: HTMLInputElement) {
    fileInput.click();
  }

  /** Runs when a file is chosen in the upload stage — validates the name & size, no upload yet. */
  onSlideDocFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.slideDocModal) return;

    const dot = file.name.lastIndexOf('.');
    const base = dot !== -1 ? file.name.substring(0, dot) : file.name;
    const ext = dot !== -1 ? file.name.substring(dot + 1).toLowerCase() : '';

    const m = this.slideDocModal;
    const expectedBase = this.expectedSlotBase(m.topic, m.activeSlot);
    const extOk = m.def.exts.includes(ext);

    const maxBytes = this.MAX_SLIDE_DOC_MB * 1024 * 1024;
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);

    m.pickedFile = file;
    m.pickedName = base;
    m.pickedExt = ext;
    m.nameMatches = (base.toLowerCase() === expectedBase.toLowerCase()) && extOk;
    m.sizeError = file.size > maxBytes
      ? `This file is ${fileSizeMb} MB. Max allowed size is ${this.MAX_SLIDE_DOC_MB} MB — please choose a smaller file.`
      : '';
    if (!m.nameMatches || m.sizeError) this.playAttachWarningSound();
  }

  /** User clicks "Rename & Continue" on a mismatched file — renames it in-memory to the expected name. */
  slideDocFixName() {
    if (!this.slideDocModal || !this.slideDocModal.pickedFile) return;
    const m = this.slideDocModal;
    const originalFile = m.pickedFile!; // narrowed to File here, unlike m.pickedFile below
    const expectedBase = this.expectedSlotBase(m.topic, m.activeSlot);

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
    this.slideDocModal.sizeError = '';
  }

  /** Confirms upload — only enabled once nameMatches is true and file is within the size limit. Uploads into the active slot (original or vN). */
  confirmSlideDocUpload() {
    const m = this.slideDocModal;
    if (!m || !m.pickedFile || !m.nameMatches || m.uploading) return;
    if (m.sizeError) {
      this.toast.error(m.sizeError);
      return;
    }

    const fileToUpload = m.pickedFile; // narrowed to File, avoids TS2322 below
    const slot = m.activeSlot;

    m.uploading = true;
    const formData = new FormData();
    formData.append('file', fileToUpload, fileToUpload.name);
    formData.append('topic_id', String(m.topic.id));
    formData.append('doc_type', m.def.type);
    formData.append('tier', slot.tier); // 'production' | 'final' | 'self'
    if (slot.version) formData.append('version', slot.version); // production-only, omit for original/final/self

    this.api.post<any>('/topics/upload-slide-doc', formData).subscribe({
      next: (r: any) => {
        if (m) m.uploading = false;
        if (r?.status) {
          m.topic[slot.field] = r.filename;
          this.toast.success(`${m.def.label} (${slot.label}) attached`);
          m.stage = 'view';
          m.pickedFile = null;
          this.refreshSlideDocSafeUrl();
        } else {
          this.toast.error(this.slideDocUploadErrorMessage(r?.message, fileToUpload, 0));
        }
      },
      error: (e: any) => {
        if (m) m.uploading = false;
        this.toast.error(this.slideDocUploadErrorMessage(e?.error?.message, fileToUpload, e?.status));
      }
    });
  }

  /** Builds a clear, user-facing message for slide-doc upload failures, calling out oversize files specifically. */
  private slideDocUploadErrorMessage(serverMessage: string | undefined, file: File, httpStatus: number): string {
    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const looksLikeSizeIssue =
      httpStatus === 413 ||
      /too large|payload|max.*size|filesize|file size|exceeds/i.test(serverMessage || '');

    if (looksLikeSizeIssue) {
      return `This file is ${fileSizeMb} MB, which is larger than the server's ${this.MAX_SLIDE_DOC_MB} MB upload limit. Please choose a smaller file.`;
    }
    return serverMessage || 'Upload failed';
  }

  /** Deletes whichever slot is currently active (original or a specific version). */
  deleteSlideDoc() {
    const m = this.slideDocModal;
    if (!m || m.deleting) return;
    const slot = m.activeSlot;
    if (!confirm(`Remove ${m.def.label} (${slot.label}) from this topic? This deletes the file from the server.`)) return;

    m.deleting = true;
    const body: any = { doc_type: m.def.type, tier: slot.tier };
    if (slot.version) body.version = slot.version;

    this.api.post<any>(`/topics/${m.topic.id}/delete-slide-doc`, body).subscribe({
      next: (r: any) => {
        if (m) m.deleting = false;
        if (r?.status) {
          m.topic[slot.field] = null;
          this.toast.success(`${m.def.label} (${slot.label}) removed`);
          m.stage = slot.tier === 'production' ? 'picker' : 'upload';
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

  /** Downloads the topic's ORIGINAL slot for a doc type (used by the compact Slide-tile buttons). */
  downloadSlideDoc(t: any, docType: SlideDocType) {
    const filename = this.slideDocFilename(t, docType);
    if (!filename) return;
    this.downloadSlideFilename(filename);
  }

  /** Downloads any slot's filename directly (used from the version picker). */
  downloadSlideFilename(filename: string) {
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
  isPreFinal(t: any): boolean { return t.topic_status === 'pre_final'; }

  /** Label used for the audit pill, matching whichever of the three states the topic is currently in. */
  statusLabel(t: any): string {
    if (this.isFinal(t)) return 'Final';
    if (this.isPreFinal(t)) return 'Pre-Final';
    return 'Pending';
  }

  /** Click handler on the Final/Pending badge. Marking Final is immediate
   *  (blocked while Pre-Final — the button is disabled in that state, this
   *  is just a defensive guard); reverting Final -> Pending opens the
   *  unlock-key modal first. */
  onStatusBadgeClick(t: any) {
    if (this.isPreFinal(t)) return;
    if (!this.isFinal(t)) {
      this.setTopicStatus(t, 'final');
    } else {
      this.openUnlockModal(t);
    }
  }

  /** Click handler on the Pre-Final badge. Toggles pre_final <-> pending.
   *  No unlock key needed either direction — Pre-Final is a lighter-weight
   *  checkpoint than Final, which is the one status that's meant to be
   *  hard to accidentally undo. Blocked while already Final (defensive
   *  guard — button is disabled in that state). */
  onPreFinalBadgeClick(t: any) {
    if (this.isFinal(t)) return;
    this.setTopicStatus(t, this.isPreFinal(t) ? 'pending' : 'pre_final');
  }

  private setTopicStatus(t: any, status: 'pending' | 'pre_final' | 'final', unlockKey?: string) {
    this.savingStatusId[t.id] = true;
    this.api.put<any>(`/topics/${t.id}/status`, { status, unlock_key: unlockKey || null }).subscribe({
      next: (r: any) => {
        this.savingStatusId[t.id] = false;
        if (r?.status) {
          t.topic_status = status;
          t.status_by = this.auth.user?.name || t.status_by;
          const label = status === 'final' ? 'Marked as Final' : status === 'pre_final' ? 'Marked as Pre-Final' : 'Reverted to Pending';
          this.toast.success(label);
          this.applyTopicFilter();
        } else {
          this.toast.error(r?.message || 'Failed to update status');
        }
      },
      error: () => { this.savingStatusId[t.id] = false; this.toast.error('Failed to update status'); }
    });
  }

  // ── Combined Pending/Pre-Final/Final status dropdown (single button,
  // replaces the old separate Set Pre-Final + Final/Pending buttons).
  // Opens upward (CSS-positioned) since the button sits low in the card. ──
  openStatusDropdownId: any = null;

  toggleStatusDropdown(t: any, event?: MouseEvent) {
    if (event) event.stopPropagation();
    if (this.isFinal(t) || this.savingStatusId[t.id]) return; // Final is locked — must use unlock flow
    this.openStatusDropdownId = this.openStatusDropdownId === t.id ? null : t.id;
  }

  closeStatusDropdown() {
    this.openStatusDropdownId = null;
  }

  isStatusDropdownOpen(t: any): boolean {
    return this.openStatusDropdownId === t.id;
  }

  /** Picks a status from the dropdown. Final still goes through the normal onStatusBadgeClick path so unlock-to-revert stays intact; here we're only ever moving TO final/pre_final/pending from a non-final state. */
  chooseTopicStatus(t: any, status: 'pending' | 'pre_final' | 'final', event?: MouseEvent) {
    if (event) event.stopPropagation();
    this.openStatusDropdownId = null;
    if (status === this.currentStatusKey(t)) return;
    this.setTopicStatus(t, status);
  }

  currentStatusKey(t: any): 'pending' | 'pre_final' | 'final' {
    if (this.isFinal(t)) return 'final';
    if (this.isPreFinal(t)) return 'pre_final';
    return 'pending';
  }

  currentStatusButtonLabel(t: any): string {
    if (this.savingStatusId[t.id]) return '…';
    if (this.isFinal(t)) return '✓ Final';
    if (this.isPreFinal(t)) return '● Pre-Final';
    return 'Pending';
  }

  @HostListener('document:click')
  onDocumentClickCloseStatusDropdown() {
    this.closeStatusDropdown();
  }

  @HostListener('document:click')
  onDocumentClickCloseExportMenu() {
    this.closeExportMenu();
  }

  @HostListener('document:click')
  onDocumentClickCloseOpenAllMenu() {
    this.closeOpenAllMenu();
  }

  @HostListener('document:click')
  onDocumentClickCloseReviewPicker() {
    this.closeReviewPicker();
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

  // ============================================================
  // BULK SELECT / BULK DELETE
  // ============================================================

  /** Set of currently-selected topic ids (drives the checkbox + drawer UI). */
  selectedTopicIds = new Set<number>();
  bulkDeleteConfirmOpen = false;
  bulkDeleting = false;

  isTopicSelected(t: any): boolean {
    return this.selectedTopicIds.has(t.id);
  }

  toggleTopicSelection(t: any, event?: Event) {
    if (event) event.stopPropagation();
    if (this.selectedTopicIds.has(t.id)) {
      this.selectedTopicIds.delete(t.id);
    } else {
      this.selectedTopicIds.add(t.id);
    }
    // Reassign so change detection on the Set reference-holders (drawer count) picks it up.
    this.selectedTopicIds = new Set(this.selectedTopicIds);
  }

  get selectedCount(): number {
    return this.selectedTopicIds.size;
  }

  clearSelection() {
    this.selectedTopicIds = new Set();
  }

  /** Names of the currently selected topics, for the confirm-modal list (capped for display). */
  get selectedTopicNames(): string[] {
    const names: string[] = [];
    for (const t of this.topics) {
      if (this.selectedTopicIds.has(t.id)) {
        names.push(t.name || t.topic_code || `Topic ${t.sequence}`);
      }
    }
    return names;
  }

  openBulkDeleteConfirm() {
    if (!this.selectedCount) return;
    this.bulkDeleteConfirmOpen = true;
  }

  closeBulkDeleteConfirm() {
    if (this.bulkDeleting) return;
    this.bulkDeleteConfirmOpen = false;
  }

  doBulkDelete() {
    if (!this.selectedCount || this.bulkDeleting) return;
    const ids = Array.from(this.selectedTopicIds);
    this.bulkDeleting = true;
    this.api.post<any>(`/topics/bulk-delete`, { ids }).subscribe({
      next: (r: any) => {
        this.bulkDeleting = false;
        this.bulkDeleteConfirmOpen = false;
        if (r?.status) {
          const deletedIds: number[] = Array.isArray(r?.deleted_ids) ? r.deleted_ids.map(Number) : ids;
          this.toast.success(r?.message || `${deletedIds.length} topic(s) deleted`);
          this.clearSelection();
          this.load();
        } else {
          this.toast.error(r?.message || 'Bulk delete failed');
        }
      },
      error: () => {
        this.bulkDeleting = false;
        this.bulkDeleteConfirmOpen = false;
        this.toast.error('Bulk delete failed');
      }
    });
  }

  isActive(t: any): boolean { return Number(t.is_active) === 1; }

  // ============================================================
  // YOUTUBE LINK — add / edit / delete / open
  // ============================================================

  ytEditingId: any = null;
  ytLinkDraft: string = '';
  savingYoutubeLink: { [id: string]: boolean } = {};

  // ── YouTube link popup card (small icon button -> popup with add/edit/delete) ──
  ytPopupForId: any = null;

  openYoutubePopup(t: any, event?: MouseEvent) {
    if (event) event.stopPropagation();
    this.ytPopupForId = this.ytPopupForId === t.id ? null : t.id;
    this.ytLinkDraft = t.youtube_link || '';
  }

  closeYoutubePopup() {
    this.ytPopupForId = null;
    this.ytLinkDraft = '';
  }

  isYoutubePopupOpen(t: any): boolean {
    return this.ytPopupForId === t.id;
  }

  /** Saves the draft link from the popup and closes it on success. */
  saveYoutubePopupLink(t: any) {
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
          this.closeYoutubePopup();
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

  /** Deletes the link from the popup. */
  deleteYoutubePopupLink(t: any) {
    this.savingYoutubeLink[t.id] = true;
    this.api.put<any>(`/topics/${t.id}`, { youtube_link: null }).subscribe({
      next: (r: any) => {
        this.savingYoutubeLink[t.id] = false;
        if (r?.status) {
          t.youtube_link = null;
          this.toast.success('Video link removed');
          this.closeYoutubePopup();
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

  // ============================================================
  // YOUTUBE AUTOMATION METHOD IMPLEMENTATION
  // ============================================================

  loadSavedYoutubeData() {
    if (!this.chapter?.chapter_code || !this.topics.length) return;
    const headers = new HttpHeaders({
      'VidyaMine': 'vidyamine',
      'Production': 'doot',
      'Content-Type': 'application/json'
    });
    this.http.get<any>(`https://rest.vidyamine.com/rest/dev/vi_studio/chapter-mis/youtube-chapter/${this.chapter.chapter_code}`, { headers }).subscribe({
      next: (res) => {
        if (res?.status && res.data) {
          res.data.forEach((row: any) => {
            const topic = this.topics.find(t => 
              String(t.id) === String(row.topic_id) || 
              t.topic_code === row.topic_id
            );
            if (topic) {
              topic.yt.desc = row.description;
              topic.yt.descState = row.desc_state;
              topic.yt.thumbState = row.thumb_state;
              topic.yt.guidancePrompt = row.guidance_prompt || '';
              topic.yt.generatedThumbUrl = row.ai_generated_image_url || null;
              topic.yt.thumb = {
                title: row.thumbnail_title || topic.name,
                kicker: row.thumbnail_kicker || this.getDefaultKicker(topic.topic_code),
                badge: row.thumbnail_badge || 'VIDYAMINE',
                palette: parseInt(row.thumbnail_palette) || 0,
                layout: parseInt(row.thumbnail_layout) || 0,
                bgImageUrl: row.thumbnail_bg_image || null
              };

              if (row.thumbnail_bg_image) {
                const img = new Image();
                img.onload = () => {
                  if (topic.yt.thumb) {
                    topic.yt.thumb.bgImage = img;
                    if (this.selectedTopic?.id === topic.id) {
                      this.drawThumbnail();
                    }
                  }
                };
                img.src = row.thumbnail_bg_image;
              }
            }
          });
        }
      }
    });
  }

  updateSafeUrls(topic: any) {
    if (!topic) {
      this.safePdfUrl = null;
      this.pptUrl = '';
      this.scriptText = '';
      return;
    }

    this.scriptText = topic.script || '';

    const rawPdfUrl = topic.slide_claude_pdf 
      ? `${this.ATTACH_BASE}/${topic.slide_claude_pdf}` 
      : (this.chapter?.file_name ? this.pdfUrl(this.chapter.file_name) : '');
    
    this.safePdfUrl = rawPdfUrl ? this.sanitizer.bypassSecurityTrustResourceUrl(rawPdfUrl) : null;

    this.pptUrl = topic.slide_gpt_ppt 
      ? `${this.ATTACH_BASE}/${topic.slide_gpt_ppt}` 
      : (topic.slide_claude_ppt ? `${this.ATTACH_BASE}/${topic.slide_claude_ppt}` : '');
  }

  openYT(topic: any) {
    this.selectedTopic = topic;   
    this.guidancePrompt = topic.yt.guidancePrompt || '';
    this.refUploadedThumbnailImgs = topic._refUploadedThumbnailImgs || [];
    this.generatingThumbImage = this.generatingThumbTopics.has(topic.topic_code);
    this.updateSafeUrls(topic);
    this.ytPanelOpen = true;
    this.canvasNeedRedraw = true;
    // Pre-load background image if any
    if (topic.yt.thumb?.bgImageUrl && !topic.yt.thumb.bgImage) {
      const img = new Image();
      img.onload = () => {
        if (topic.yt.thumb) {
          topic.yt.thumb.bgImage = img;
          this.drawThumbnail();
          this.drawRefThumbnail();
        }
      };
      img.src = topic.yt.thumb.bgImageUrl;
    }
  }

  closeYT() {
    this.ytPanelOpen = false;
    this.selectedTopic = null;
    this.refUploadedThumbnailImgs = [];
    this.ytPreviewImgUrl = null;
    this.updateSafeUrls(null);
    this.closeSide();
  }

  compressImage(base64Str: string, maxWidth: number, maxHeight: number, quality: number, callback: (result: string) => void) {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        callback(canvas.toDataURL('image/jpeg', quality));
      } else {
        callback(base64Str);
      }
    };
    img.onerror = () => {
      callback(base64Str);
    };
  }

  uploadReferenceThumbnailAttachment(event: any) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const remainingSlots = 4 - this.refUploadedThumbnailImgs.length;
    if (remainingSlots <= 0) {
      this.toast.error('You can upload a maximum of 4 reference images');
      return;
    }

    const filesToUpload = Array.from(files).slice(0, remainingSlots);
    let count = 0;

    filesToUpload.forEach((file: any) => {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        this.compressImage(e.target.result, 800, 450, 0.7, (compressedData) => {
          this.refUploadedThumbnailImgs.push(compressedData);
          if (this.selectedTopic) {
            this.selectedTopic._refUploadedThumbnailImgs = this.refUploadedThumbnailImgs;
          }
          count++;
          if (count === filesToUpload.length) {
            this.toast.success(`Attached ${filesToUpload.length} reference image(s) for visual AI analysis`);
          }
        });
      };
      reader.readAsDataURL(file);
    });
    // Clear input so same file selection works next time
    event.target.value = '';
  }

  removeUploadedRefThumb(index: number) {
    this.refUploadedThumbnailImgs.splice(index, 1);
    if (this.selectedTopic) {
      this.selectedTopic._refUploadedThumbnailImgs = this.refUploadedThumbnailImgs;
    }
    this.toast.success('Reference thumbnail removed');
  }

  loadTeacherPhotos() {
    const headers = new HttpHeaders({
      'VidyaMine': 'vidyamine',
      'Production': 'doot'
    });
    this.http.get<any>('https://rest.vidyamine.com/rest/dev/vm_doot/library/teacher-photos/', { headers }).subscribe({
      next: (res) => {
        if (res?.status && Array.isArray(res.data)) {
          this.teacherPhotos = res.data;
        }
      },
      error: (err) => {
        console.error('Failed to load teacher photos:', err);
      }
    });
  }

  async onTeacherPhotoSelect(event: any) {
    const docId = event.target.value;
    if (!docId) return;

    const photo = this.teacherPhotos.find(p => p.id == docId);
    if (!photo || !photo.file_url) return;

    const remainingSlots = 4 - this.refUploadedThumbnailImgs.length;
    if (remainingSlots <= 0) {
      this.toast.error('You can upload a maximum of 4 reference images');
      event.target.value = '';
      return;
    }

    this.toast.show(`Fetching teacher photo (${photo.name || photo.fname})...`);
    try {
      const response = await fetch(photo.file_url);
      if (!response.ok) throw new Error('Failed to fetch image from server');
      const blob = await response.blob();

      const reader = new FileReader();
      reader.onload = (e: any) => {
        this.compressImage(e.target.result, 800, 450, 0.7, (compressedData) => {
          this.refUploadedThumbnailImgs.push(compressedData);
          if (this.selectedTopic) {
            this.selectedTopic._refUploadedThumbnailImgs = this.refUploadedThumbnailImgs;
          }
          this.toast.success(`Attached Teacher Photo: ${photo.name || photo.fname}`);
        });
      };
      reader.readAsDataURL(blob);
    } catch (err: any) {
      console.error('Failed to attach teacher photo:', err);
      this.toast.error('Failed to attach teacher photo: ' + (err.message || 'Network error'));
    } finally {
      event.target.value = '';
    }
  }

  loadVaultPrompts() {
    const headers = new HttpHeaders({
      'VidyaMine': 'vidyamine',
      'Production': 'doot'
    });
    this.http.get<any>('https://rest.vidyamine.com/rest/dev/vm_doot/prompt-vault-v2/', { headers }).subscribe({
      next: (res) => {
        if (res?.status && Array.isArray(res.data)) {
          this.vaultPrompts = res.data;
        }
      },
      error: (err) => {
        console.error('Failed to load vault prompts:', err);
      }
    });
  }

  onVaultPromptSelect(event: any) {
    const promptId = event.target.value;
    if (!promptId) return;

    const p = this.vaultPrompts.find(item => item.id == promptId);
    if (p && p.body) {
      const bodyText = p.body.trim();
      if (this.guidancePrompt && this.guidancePrompt.trim()) {
        this.guidancePrompt = this.guidancePrompt.trim() + '\n\n' + bodyText;
      } else {
        this.guidancePrompt = bodyText;
      }
      this.toast.success(`Prompt "${p.name}" inserted!`);
    } else {
      this.toast.error('Selected prompt has no text body.');
    }
    event.target.value = '';
  }

  openYtImagePreview(url: string) {
    this.ytPreviewImgUrl = url;
  }

  closeYtImagePreview() {
    this.ytPreviewImgUrl = null;
  }

  generateYT(topic: any, event: Event, mode: 'desc' | 'thumb' | 'both' = 'both') {
    event.stopPropagation();

    this.openaiKey = localStorage.getItem('vmss_key') || '';
    if (!this.openaiKey.trim()) {
      this.toast.error('API key not found. Please configure your OpenAI API Key in the AI-slides module.');
      return;
    }

    // If mode involves thumbnail AND the user has uploaded reference images,
    // warn upfront about AI image generation cost before any API call.
    const refImgs = topic._refUploadedThumbnailImgs || this.refUploadedThumbnailImgs || [];
    const willGenAiImage = (mode === 'both' || mode === 'thumb') && refImgs.length > 0;
    if (willGenAiImage) {
      const confirmed = window.confirm(
        '⚠️ AI Image Generation will follow\n\n' +
        'After generating the thumbnail layout, a real AI image will be generated via gpt-image-1.\n\n' +
        '• Estimated cost: ~$0.04 per image\n' +
        '• Total time: 60–120 seconds\n' +
        '• Output size: 1536×1024 (landscape 16:9)\n\n' +
        'Continue?'
      );
      if (!confirmed) return;
    }

    this.generatingYt = true;
    this.generatingTopicId = topic.id;
    this.ytGenMode = mode;

    // Build absolute URL for screenshots to send to multimodal API
    const screenshotsUrls = (topic._screenshots || []).map((filename: string) => 
      `${this.SCREENSHOT_BASE}/${filename}`
    );
    (refImgs || []).forEach((img: string) => {
      screenshotsUrls.push(img);
    });

    // Build files map for the AI script and other sources
    let scriptText = '';
    if (topic.slide_claude_pdf) {
      scriptText = `Topic: ${topic.name}. Slide text is in ${topic.slide_claude_pdf}.`;
    } else {
      scriptText = `Introduction to ${topic.name}.`;
    }

    const payload = {
      api_key: this.openaiKey.trim(),
      topic: topic.name,
      chapter: this.chapter?.name || '',
      script: scriptText,
      screenshots: screenshotsUrls,
      ref_description: topic.yt.desc || '',
      ref_thumbnail: topic.yt.thumb ? {
        title: topic.yt.thumb.title,
        kicker: topic.yt.thumb.kicker,
        badge: topic.yt.thumb.badge,
        palette: topic.yt.thumb.palette,
        layout: topic.yt.thumb.layout
      } : null,
      guidance_prompt: this.guidancePrompt,
      use_ref_desc: this.useRefDesc,
      use_ref_thumb: this.useRefThumb,
      mode: mode
    };

    const headers = new HttpHeaders({
      'VidyaMine': 'vidyamine',
      'Production': 'doot',
      'Content-Type': 'application/json'
    });
    this.http.post<any>('https://rest.vidyamine.com/rest/dev/vi_studio/chapter-mis/generate-yt', payload, { headers }).subscribe({
      next: (res) => {
        if (!res?.status || !res.data) {
          this.generatingYt = false;
          this.generatingTopicId = '';
          this.toast.error(res?.message || 'Failed to generate YouTube content');
          return;
        }

        topic.yt.guidancePrompt = this.guidancePrompt;

        if (mode === 'both' || mode === 'desc') {
          topic.yt.desc = res.data.description;
          topic.yt.descState = 'draft';
        }
        if (mode === 'both' || mode === 'thumb') {
          topic.yt.thumbState = 'draft';
          topic.yt.thumb = {
            title: res.data.thumbnail.title || topic.name,
            kicker: res.data.thumbnail.kicker || this.getDefaultKicker(topic.topic_code),
            badge: res.data.thumbnail.badge || 'VIDYAMINE',
            palette: parseInt(res.data.thumbnail.palette) || 0,
            layout: parseInt(res.data.thumbnail.layout) || 0,
            bgImage: (mode === 'thumb' && topic.yt.thumb) ? topic.yt.thumb.bgImage : null,
            bgImageUrl: (mode === 'thumb' && topic.yt.thumb) ? topic.yt.thumb.bgImageUrl : null
          };
        }

        // Redraw canvas directly without calling openYT() to preserve refUploadedThumbnailImgs
        this.guidancePrompt = topic.yt.guidancePrompt || this.guidancePrompt;
        this.canvasNeedRedraw = true;
        setTimeout(async () => {
          this.drawThumbnail();
          this.drawRefThumbnail();
          
          // Auto-trigger AI image generation when thumbnail mode and refs are available
          if (willGenAiImage) {
            this.toast.success('🎨 Canvas layout ready. Now rendering real AI image (may take 60s)...');
            await this.generateThumbnailImage(true, topic); // skip confirm
          } else {
            this.toast.success(`⚡ YouTube content generated successfully for ${topic.name}!`);
          }
          
          this.generatingYt = false;
          this.generatingTopicId = '';
          this.saveYoutubeData(topic, true); // silent — generation toast already shown
        }, 50);
      },
      error: (err) => {
        this.generatingYt = false;
        this.generatingTopicId = '';
        let errorMsg = 'Verify your API key and backend connection.';
        if (err?.error?.message) {
          errorMsg = err.error.message;
        } else if (err?.error?.error?.message) {
          errorMsg = err.error.error.message;
        } else if (err?.message) {
          errorMsg = err.message;
        }
        this.toast.error('Generation failed: ' + errorMsg);
      }
    });
  }

  onDescChange(text: string) {
    if (this.selectedTopic) {
      this.selectedTopic.yt.desc = text;
      this.selectedTopic.yt.descState = 'draft';
    }
  }

  copyDesc() {
    if (this.selectedTopic?.yt.desc) {
      navigator.clipboard.writeText(this.selectedTopic.yt.desc).then(() => {
        this.toast.success('Description copied to clipboard');
      });
    }
  }

  downloadDesc() {
    if (this.selectedTopic?.yt.desc) {
      const blob = new Blob([this.selectedTopic.yt.desc], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.selectedTopic.topic_code}_description.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  unlockDesc() {
    if (this.selectedTopic) {
      this.selectedTopic.yt.descState = 'draft';
    }
  }

  finaliseDesc() {
    if (this.selectedTopic) {
      this.selectedTopic.yt.descState = 'final';
      this.selectedTopic.yt.guidancePrompt = this.guidancePrompt;
      this.saveYoutubeData(this.selectedTopic);
    }
  }

  onThumbFieldChange(field: string, val: any) {
    if (this.selectedTopic?.yt.thumb) {
      (this.selectedTopic.yt.thumb as any)[field] = val;
      this.selectedTopic.yt.thumbState = 'draft';
      this.canvasNeedRedraw = true;
    }
  }

  setPalette(idx: number) {
    if (this.selectedTopic?.yt.thumb) {
      this.selectedTopic.yt.thumb.palette = idx;
      this.selectedTopic.yt.thumbState = 'draft';
      this.canvasNeedRedraw = true;
    }
  }

  setLayout(idx: number) {
    if (this.selectedTopic?.yt.thumb) {
      this.selectedTopic.yt.thumb.layout = idx;
      this.selectedTopic.yt.thumbState = 'draft';
      this.canvasNeedRedraw = true;
    }
  }

  uploadThumbnailBg(event: any) {
    const file = event.target.files[0];
    if (file && this.selectedTopic?.yt.thumb) {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        const bgUrl = e.target.result;
        const img = new Image();
        img.onload = () => {
          if (this.selectedTopic?.yt.thumb) {
            this.selectedTopic.yt.thumb.bgImage = img;
            this.selectedTopic.yt.thumb.bgImageUrl = bgUrl;
            this.selectedTopic.yt.thumbState = 'draft';
            this.canvasNeedRedraw = true;
          }
        };
        img.src = bgUrl;
      };
      reader.readAsDataURL(file);
    }
  }

  clearThumbnailBg() {
    if (this.selectedTopic?.yt.thumb) {
      this.selectedTopic.yt.thumb.bgImage = null;
      this.selectedTopic.yt.thumb.bgImageUrl = null;
      this.selectedTopic.yt.thumbState = 'draft';
      this.canvasNeedRedraw = true;
    }
  }

  openImageInNewTab(url: string) {
    if (url) {
      window.open(url, '_blank');
    }
  }

  async downloadThumbnail() {
    const url = this.selectedTopic?.yt.generatedThumbUrl;
    if (!url) {
      this.toast.error('No AI image generated yet to download.');
      return;
    }

    if (url.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.selectedTopic.topic_code}_ai_thumb.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }

    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const localUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = localUrl;
      a.download = `${this.selectedTopic.topic_code}_ai_thumb.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(localUrl);
    } catch (error) {
      console.error('Download failed, falling back to new tab:', error);
      window.open(url, '_blank');
    }
  }

  unlockThumb() {
    if (this.selectedTopic) {
      this.selectedTopic.yt.thumbState = 'draft';
    }
  }

  deleteThumbnail() {
    if (!this.selectedTopic) return;
    if (confirm('Are you sure you want to delete this thumbnail layout? This will reset the state.')) {
      this.selectedTopic.yt.thumbState = 'none';
      this.selectedTopic.yt.thumb = null;
      this.saveYoutubeData(this.selectedTopic);
      this.toast.success('Thumbnail layout deleted');
    }
  }

  deleteDescription() {
    if (!this.selectedTopic) return;
    if (confirm('Are you sure you want to delete this description? This will reset the state.')) {
      this.selectedTopic.yt.descState = 'none';
      this.selectedTopic.yt.desc = '';
      this.saveYoutubeData(this.selectedTopic);
      this.toast.success('Description deleted');
    }
  }

  finaliseThumb() {
    if (this.selectedTopic) {
      this.selectedTopic.yt.thumbState = 'final';
      this.selectedTopic.yt.guidancePrompt = this.guidancePrompt;
      this.saveYoutubeData(this.selectedTopic);
    }
  }

  saveYoutubeData(topic: any, silent = false) {
    const thumb = topic.yt.thumb;
    const payload = {
      topic_id: topic.topic_code, // Use topic_code string as key
      chapter_id: this.chapter?.chapter_code || '',
      description: topic.yt.desc,
      thumbnail_title: thumb?.title || '',
      thumbnail_kicker: thumb?.kicker || '',
      thumbnail_badge: thumb?.badge || '',
      thumbnail_palette: thumb?.palette ?? 0,
      thumbnail_layout: thumb?.layout ?? 0,
      thumbnail_bg_image: thumb?.bgImageUrl || '',
      desc_state: topic.yt.descState,
      thumb_state: topic.yt.thumbState,
      guidance_prompt: this.guidancePrompt
    };

    const headers = new HttpHeaders({
      'VidyaMine': 'vidyamine',
      'Production': 'doot',
      'Content-Type': 'application/json'
    });
    this.http.post<any>('https://rest.vidyamine.com/rest/dev/vi_studio/chapter-mis/youtube', payload, { headers }).subscribe({
      next: (res) => {
        if (res?.status) {
          if (!silent) this.toast.success(`Successfully saved YouTube configuration for ${topic.name}`);
        } else {
          this.toast.error(res?.message || 'Failed to save configuration');
        }
      },
      error: () => {
        this.toast.error('Save request failed');
      }
    });
  }

  // Reusable Canvas drawing implementation
  drawThumbnailOnCanvas(canvas: HTMLCanvasElement, TH: any) {
    if (!canvas || !TH) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 1280;
    const H = 720;
    canvas.width = W;
    canvas.height = H;

    const pal = this.ytPalettes[TH.palette] || this.ytPalettes[0];
    const pad = 60;

    if (!TH.bgImage && TH.palette === 3 && TH.layout === 0) {
      // 1. Draw Deep Blue Premium Gradient Background
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#062042');
      g.addColorStop(1, '#020e20');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // 2. Draw Dotted Grid Pattern on the right
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      for (let x = W * 0.58; x < W; x += 30) {
        for (let y = 80; y < H - 80; y += 30) {
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 3. Draw Floating Outlines (triangle, circle, square)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 3;
      // Triangle
      ctx.beginPath();
      ctx.moveTo(800, 140);
      ctx.lineTo(825, 185);
      ctx.lineTo(775, 185);
      ctx.closePath();
      ctx.stroke();
      // Circle
      ctx.beginPath();
      ctx.arc(855, 160, 18, 0, Math.PI * 2);
      ctx.stroke();
      // Square
      ctx.strokeRect(895, 142, 32, 32);

      // 4. Draw Standing Instructor Silhouette Placeholder on the right (matched style)
      const silGrad = ctx.createLinearGradient(W - 350, H, W - 50, H);
      silGrad.addColorStop(0, 'rgba(255, 255, 255, 0.04)');
      silGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.15)');
      silGrad.addColorStop(1, 'rgba(255, 255, 255, 0.30)');
      ctx.fillStyle = silGrad;
      // Head
      ctx.beginPath();
      ctx.arc(W - 220, H - 370, 60, 0, Math.PI * 2);
      ctx.fill();
      // Neck
      ctx.fillRect(W - 238, H - 315, 36, 40);
      // Torso & Shoulders
      ctx.beginPath();
      ctx.moveTo(W - 380, H);
      ctx.lineTo(W - 380, H - 210);
      ctx.quadraticCurveTo(W - 360, H - 270, W - 300, H - 270);
      ctx.lineTo(W - 140, H - 270);
      ctx.quadraticCurveTo(W - 80, H - 270, W - 60, H - 210);
      ctx.lineTo(W - 60, H);
      ctx.closePath();
      ctx.fill();
      // Folded arms outline
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(W - 320, H - 190);
      ctx.lineTo(W - 120, H - 190);
      ctx.stroke();

      // 5. Draw Vidya Mine Badge Capsule (Top Right)
      ctx.fillStyle = '#FFFFFF';
      this.drawRoundedRect(ctx, W - 300, 40, 230, 65, 12);
      ctx.fill();
      // Logo icon box
      ctx.fillStyle = '#085BB6';
      this.drawRoundedRect(ctx, W - 285, 52, 40, 40, 6);
      ctx.fill();
      // Logo 'V' shape inside icon box
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(W - 275, 62);
      ctx.lineTo(W - 265, 80);
      ctx.lineTo(W - 255, 62);
      ctx.lineTo(W - 260, 62);
      ctx.lineTo(W - 265, 72);
      ctx.lineTo(W - 270, 62);
      ctx.closePath();
      ctx.fill();
      // Badge text
      ctx.fillStyle = '#085BB6';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(TH.badge || 'Vidya Mine', W - 235, 72);

      // 6. Draw Title Cards on the Left Side
      ctx.textBaseline = 'middle';

      // (a) Kicker Capsule ("CLASS 06 MATHEMATICS")
      ctx.fillStyle = '#0a2140';
      this.drawRoundedRect(ctx, pad, 40, 440, 60, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Yellow tag for "CLASS 06"
      ctx.fillStyle = '#facc15';
      this.drawRoundedRect(ctx, pad + 5, 45, 170, 50, 6);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(TH.kicker && TH.kicker.includes('CLASS') ? TH.kicker.split(' ')[0] + ' ' + TH.kicker.split(' ')[1] : 'CLASS 06', pad + 90, 70);
      // White text for Subject
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(TH.kicker && TH.kicker.includes('CLASS') ? TH.kicker.substring(TH.kicker.indexOf('CLASS') + 8).replace(/^[·\s]+/, '') : 'MATHEMATICS', pad + 195, 70);

      // (b) Sub-kicker Capsule ("NCERT GANITA PRAKASH (2026-27)")
      ctx.fillStyle = '#FFFFFF';
      this.drawRoundedRect(ctx, pad, 115, 400, 45, 22);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('NCERT GANITA PRAKASH (2026-27)', pad + 200, 137);

      // (c) Chapter Number Tag ("CH - 1")
      ctx.fillStyle = '#facc15';
      this.drawRoundedRect(ctx, pad + 120, 185, 180, 45, 8);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText('CH - 1', pad + 210, 207);

      // (d) Main Chapter Card (Navy blue background, white text)
      ctx.fillStyle = '#081d38';
      this.drawRoundedRect(ctx, pad, 245, 500, 120, 16);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText('PATTERN IN', pad + 250, 285);
      ctx.fillStyle = '#facc15';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText('MATHEMATICS', pad + 250, 325);

      // (e) Topic Capsule
      ctx.fillStyle = '#085BB6';
      this.drawRoundedRect(ctx, pad + 190, 380, 120, 35, 6);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('TOPIC', pad + 250, 397);

      // (f) Main white Topic Card with navy/red text
      ctx.fillStyle = '#FFFFFF';
      this.drawRoundedRect(ctx, pad, 430, 500, 120, 16);
      ctx.fill();
      ctx.strokeStyle = '#085BB6';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#0a2140';
      ctx.font = 'bold 32px sans-serif';
      ctx.fillText('PATTERNS IN', pad + 250, 470);
      ctx.fillStyle = '#b91c1c'; // Red
      ctx.font = 'bold 42px sans-serif';
      // Use actual generated title if provided, otherwise default to "NUMBERS"
      const titleClean = TH.title ? TH.title.toUpperCase() : 'NUMBERS';
      ctx.fillText(titleClean.length > 14 ? titleClean.split(' ')[0] : titleClean, pad + 250, 515);

      // (g) Year capsule
      ctx.fillStyle = '#facc15';
      this.drawRoundedRect(ctx, pad + 170, 565, 160, 35, 8);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('(2026-27)', pad + 250, 582);

      // 7. Draw tagline footer at the bottom right
      ctx.textAlign = 'right';
      ctx.fillStyle = '#facc15';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(this.tagline, W - pad, H - 40);

    } else {
      // Background drawing
      if (TH.bgImage) {
        ctx.drawImage(TH.bgImage, 0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fillRect(0, 0, W, H);
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, pal.bg);
        g.addColorStop(1, this.shadeColor(pal.bg, -18));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        ctx.globalAlpha = 0.12;
        ctx.fillStyle = pal.accent;
        ctx.beginPath();
        ctx.arc(W - 160, 150, 220, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      const padGeneric = 70;
      const lay = TH.layout;

      // Draw Badge
      ctx.font = 'bold 30px sans-serif';
      const badgeText = TH.badge || 'VIDYAMINE';
      const badgeW = ctx.measureText(badgeText).width + 40;
      this.drawRoundedRect(ctx, padGeneric, 52, badgeW, 50, 25);
      ctx.fillStyle = pal.accent;
      ctx.fill();
      ctx.fillStyle = (pal.name === 'Gold/Green') ? '#003F36' : '#3a2f00';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(badgeText, padGeneric + 20, 78);
      
      // Draw content copy text
      ctx.textBaseline = 'alphabetic';
      let textX = padGeneric;
      let textY = H * 0.42;
      let align: 'left' | 'center' | 'right' = 'left';
      const maxW = W - 2 * padGeneric;

      if (lay === 1) { // Centered
        align = 'center';
        textX = W / 2;
        textY = H * 0.40;
      } else if (lay === 2) { // Lower band
        textY = H * 0.60;
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.fillRect(0, H * 0.50, W, H * 0.50);
      }

      // Draw Kicker
      ctx.fillStyle = pal.accent;
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = align;
      if (TH.kicker) {
        ctx.fillText(TH.kicker, textX, textY - 70);
      }

      // Draw Title
      ctx.fillStyle = pal.text;
      const titleText = TH.title || '';
      const size = titleText.length > 34 ? 70 : titleText.length > 22 ? 86 : 104;
      ctx.font = `bold ${size}px Georgia, serif`;
      this.wrapText(ctx, titleText, textX, textY, maxW, size * 1.08, align, 4);

      // Draw Tagline Footer
      ctx.textAlign = 'right';
      ctx.fillStyle = pal.accent;
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(this.tagline, W - padGeneric, H - 40);
    }
    ctx.textAlign = 'left';
  }

  drawThumbnail() {}
  drawRefThumbnail() {}

  openThumbnailPreview() {
    if (this.selectedTopic?.yt.generatedThumbUrl) {
      this.ytPreviewImgUrl = this.selectedTopic.yt.generatedThumbUrl;
    }
  }

  private dataURLtoBlob(dataURL: string): Blob {
    const [head, body] = dataURL.split(',');
    const mime = head.match(/data:(.*?);/)?.[1] || 'image/png';
    const bin = atob(body);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  private dataURLtoPngBlob(dataURL: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = dataURL;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Canvas conversion to PNG blob failed'));
            }
          }, 'image/png');
        } else {
          reject(new Error('Canvas 2D context not available'));
        }
      };
      img.onerror = (err) => reject(err);
    });
  }

  async generateThumbnailImage(skipConfirm = false, targetTopic?: any) {
    const topic = targetTopic || this.selectedTopic;
    if (!topic) {
      this.toast.error('No topic selected for thumbnail generation.');
      return;
    }
    const topicCode = topic.topic_code;
    const refImgs = [...(topic._refUploadedThumbnailImgs || this.refUploadedThumbnailImgs || [])];

    this.openaiKey = localStorage.getItem('vmss_key') || '';
    if (!this.openaiKey.trim()) {
      this.toast.error('API key not found. Please configure your OpenAI API Key in the AI-slides module.');
      return;
    }
    if (!refImgs.length) {
      this.toast.error('Please upload at least one reference thumbnail via "+Upload Ref" before generating an AI image.');
      return;
    }

    if (!skipConfirm) {
      const confirmed = window.confirm(
        '⚠️ AI Image Generation\n\n' +
        'This will send your reference thumbnail(s) to OpenAI to generate a real image.\n\n' +
        '• Estimated cost: ~$0.04 per image\n' +
        '• Time: 30–90 seconds\n' +
        '• Output size: 1536×1024 (landscape 16:9)\n\n' +
        'Continue?'
      );
      if (!confirmed) return;
    }

    this.generatingThumbTopics.add(topicCode);
    if (this.selectedTopic?.topic_code === topicCode) {
      this.generatingThumbImage = true;
    }

    const thumb = topic.yt.thumb;
    const promptParts = [
      this.guidancePrompt?.trim() || '',
      'Create a premium educational YouTube thumbnail.',
      thumb?.title ? `Title text on thumbnail: "${thumb.title}"` : '',
      thumb?.kicker ? `Kicker/subtitle line: "${thumb.kicker}"` : '',
      thumb?.badge ? `Badge text: "${thumb.badge}"` : '',
      'Match the visual style, layout, colors, typography and design of the provided reference image(s) as closely as possible.',
      'Output a high-quality landscape YouTube thumbnail.'
    ].filter(Boolean);
    const prompt = promptParts.join(' ');
    try {
      this.toast.show('Preparing reference images...');
      const fd = new FormData();
      fd.append('model', 'gpt-image-2');
      fd.append('prompt', prompt);

      for (let i = 0; i < refImgs.length; i++) {
        const pngBlob = await this.dataURLtoPngBlob(refImgs[i]);
        fd.append('image[]', pngBlob, `ref_${i + 1}.png`);
      }

      this.toast.show('Generating AI background image via gpt-image-2...');
      const res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { 
          'Authorization': 'Bearer ' + this.openaiKey.trim()
        },
        body: fd
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errMsg = errText;
        try {
          const errObj = JSON.parse(errText);
          if (errObj.error?.message) {
            errMsg = errObj.error.message;
          }
        } catch (e) {
          // ignore parse error
        }
        throw new Error(`${res.status} Error - ${errMsg}`);
      }

      const data = await res.json();
      const b64 = data.data?.[0]?.b64_json || data.data?.[0]?.url;
      if (!b64) throw new Error('API returned no image data');

      // Update UI immediately with the generated image
      let displayUrl = b64;
      if (!b64.startsWith('http') && !b64.startsWith('data:')) {
        displayUrl = 'data:image/png;base64,' + b64;
      }
      topic.yt.generatedThumbUrl = displayUrl;
      if (this.selectedTopic?.topic_code === topicCode) {
        this.selectedTopic.yt.generatedThumbUrl = displayUrl;
      }
      this.toast.success(`🎨 AI thumbnail image generated successfully for ${topic.name}!`);

      // Post the base64 string to the backend to save it permanently in the background
      const headers = new HttpHeaders({
        'VidyaMine': 'vidyamine',
        'Production': 'doot',
        'Content-Type': 'application/json'
      });
      this.http.post('https://rest.vidyamine.com/rest/dev/vi_studio/chapter-mis/youtube-ai-image', {
        topic_id: topicCode,
        b64_data: b64
      }, { headers }).subscribe({
        next: (saveRes: any) => {
          if (saveRes?.status && saveRes?.image_url) {
            topic.yt.generatedThumbUrl = saveRes.image_url;
            if (this.selectedTopic?.topic_code === topicCode) {
              this.selectedTopic.yt.generatedThumbUrl = saveRes.image_url;
            }
            console.log('AI Image saved to database permanently:', saveRes.image_url);
            this.saveYoutubeData(topic, true);
          } else {
            console.error('Failed to save AI image to database:', saveRes?.message);
          }
        },
        error: (err) => {
          console.error('Error saving AI image to database:', err);
        }
      });
    } catch (err: any) {
      console.error(err);
      this.toast.error('Image generation failed: ' + (err.message || 'Unknown error'));
    } finally {
      this.generatingThumbTopics.delete(topicCode);
      if (this.selectedTopic?.topic_code === topicCode) {
        this.generatingThumbImage = false;
      }
    }
  }

  drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, align: 'left'|'center'|'right', maxL: number) {
    const words = text.split(/\s+/);
    let line = '';
    let lines = [];
    for (const word of words) {
      const testLine = line ? line + ' ' + word : word;
      if (ctx.measureText(testLine).width > maxW && line) {
        lines.push(line);
        line = word;
      } else { // line fct is to prevent the overriding 
        line = testLine;
      }
    }
    if (line) lines.push(line);
    lines = lines.slice(0, maxL);
    ctx.textAlign = align;
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
  }

  shadeColor(hex: string, percent: number): string {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;
    
    const r = Math.max(0, Math.min(255, R));
    const g = Math.max(0, Math.min(255, G));
    const b = Math.max(0, Math.min(255, B));
    
    return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }

  // Sidebar actions
  openSide(kind: 'script' | 'ppt' | 'pdf') {
    this.sidePanelKind = kind;
    this.sidePanelOpen = true;
  }

  closeSide() {
    this.sidePanelOpen = false;
    this.sidePanelKind = null;
  }

  get selectedTopicFiles() {
    if (!this.selectedTopic) return null;
    const t = this.selectedTopic;
    
    const pdfUrl = t.slide_claude_pdf 
      ? `${this.ATTACH_BASE}/${t.slide_claude_pdf}` 
      : (this.chapter?.file_name ? this.pdfUrl(this.chapter.file_name) : '');

    const pptUrl = t.slide_gpt_ppt 
      ? `${this.ATTACH_BASE}/${t.slide_gpt_ppt}` 
      : (t.slide_claude_ppt ? `${this.ATTACH_BASE}/${t.slide_claude_ppt}` : '');

    return {
      script: t.script || '',
      ppt: pptUrl,
      pdf: pdfUrl ? this.sanitizer.bypassSecurityTrustResourceUrl(pdfUrl) : ''
    };
  }
}