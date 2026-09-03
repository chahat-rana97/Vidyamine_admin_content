import { Component, EventEmitter, Input, Output, OnChanges, SimpleChanges, ViewChild, ElementRef, AfterViewInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { jsPDF } from 'jspdf';
import * as pdfjsLib from 'pdfjs-dist';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

/** One slide handed to the Canvas screen from the compare-view's non-screenshot pane. */
export interface CanvasSourceSlide {
  pageKey: string;
  label: string;
  /** Rasterized bitmap (data URL) — already rendered by the parent via rasterizeItem(). */
  thumb: string;
  isFinal: boolean;
  comments: { id: number; text: string; author: string | null; resolved: boolean | number }[];
  aiGeneratedThumb?: string;
}

/** A slide imported directly from a PDF picked on the user's own machine.
 *  Comments on these are kept purely client-side (never sent to the backend) —
 *  imports exist only to be composed into the canvas for a future API run. */
interface ImportedSlide {
  uid: string;
  name: string;
  thumb: string;
  comments: { id: number; text: string; author: string | null; resolved: boolean | number }[];
}

/** One tile placed on the right-hand canvas. */
interface CanvasTile {
  uid: string;
  thumb: string;
  rot: number;
  src: 'source' | 'import';
  pageKey?: string;   // set when src === 'source'
  importUid?: string; // set when src === 'import' — links back to the ImportedSlide for its local comment thread
  label?: string;
}

type CanvasViewMode = 'grid' | 'list';
type SectionKind = 'final' | 'commented' | 'none';

/** One undo/redo step for the image editor — everything a single committed action can change. */
interface EditorSnapshot {
  rotate: number; flipH: boolean; flipV: boolean; invert: boolean;
  angle: number; brightness: number; contrast: number;
  strokes: { color: string; width: number; points: { x: number; y: number }[] }[];
  shapes: { kind: 'rect' | 'ellipse' | 'arrow'; x: number; y: number; w: number; h: number; color: string }[];
  texts: { text: string; x: number; y: number; size: number; color: string }[];
  cropRect: { x: number; y: number; w: number; h: number } | null;
}

@Component({
  selector: 'app-canvas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './canvas.component.html',
  styleUrls: ['./canvas.component.css']
})
export class CanvasComponent implements OnChanges, AfterViewInit {

  // ============================================================
  // INPUTS / OUTPUTS
  // ============================================================

  /** Slides from whichever pane in the compare screen is NOT 'screenshots'. */
  @Input() slides: CanvasSourceSlide[] = [];
  /** Label of the source document (e.g. "Claude PDF") shown in the header. */
  @Input() docLabel = 'Document';
  @Input() topicName = '';

  @Output() closed = new EventEmitter<void>();
  /** Emitted when a new comment is submitted for a source slide (mini card or Zoom modal). Parent is responsible for the actual API call and updating `slides` with the result. */
  @Output() addComment = new EventEmitter<{ pageKey: string; text: string }>();
  /** Emitted when an existing comment's text is edited. */
  @Output() editComment = new EventEmitter<{ commentId: number; text: string }>();

  @ViewChild('importInput') importInput?: ElementRef<HTMLInputElement>;
  @ViewChild('editorCanvas') editorCanvasRef?: ElementRef<HTMLCanvasElement>;
  constructor(
    private cdr: ChangeDetectorRef,
    private api: ApiService,
    public toast: ToastService,
    private http: HttpClient
  ) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['slides']) {
      // Selection defaults to "everything included" — only exclusions are tracked.
      this.leftExclusions.clear();
      // Keep the Zoom modal's comment list live if it's open on a slide whose comments just changed.
      if (this.zoomOpen && this.zoomPageKey) {
        const fresh = this.slides.find(s => s.pageKey === this.zoomPageKey);
        if (fresh) this.zoomComments = fresh.comments;
      }
    }
  }

  ngAfterViewInit() {
    try {
      if (pdfjsLib?.GlobalWorkerOptions) {
        const cvBaseHref = (document.querySelector('base')?.getAttribute('href') || '/').replace(/\/$/, '');
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${cvBaseHref}/assets/pdf.worker.min.mjs`;
      }
    } catch { /* non-fatal */ }
    this.loadVaultPrompts();
  }

  close() { this.closed.emit(); }

  // ============================================================
  // LEFT PANEL — triage sections (Final / Commented / Not assigned)
  // ============================================================

  imports: ImportedSlide[] = [];
  importing = false;

  get finals(): CanvasSourceSlide[] {
    return this.slides.filter(s => s.isFinal);
  }
  get commented(): CanvasSourceSlide[] {
    return this.slides.filter(s => !s.isFinal && s.comments.length > 0);
  }
  get notAssigned(): CanvasSourceSlide[] {
    return this.slides.filter(s => !s.isFinal && s.comments.length === 0);
  }

  sectionSlides(kind: SectionKind): CanvasSourceSlide[] {
    if (kind === 'final') return this.finals;
    if (kind === 'commented') return this.commented;
    return this.notAssigned;
  }

  // Selection for the (disabled) API run counters — everything is "in" by default,
  // only exclusions are tracked, matching the reference behavior.
  private leftExclusions = new Set<string>();
  isLeftSelected(pageKey: string): boolean { return !this.leftExclusions.has(pageKey); }
  setLeftSelected(pageKey: string, on: boolean) {
    if (on) this.leftExclusions.delete(pageKey); else this.leftExclusions.add(pageKey);
  }
  get selectedFinalsCount(): number {
    return this.finals.filter(s => this.isLeftSelected(s.pageKey)).length;
  }
  get selectedCommentedCount(): number {
    return this.commented.filter(s => this.isLeftSelected(s.pageKey)).length;
  }

  trackByPageKey(_i: number, s: CanvasSourceSlide) { return s.pageKey; }

  /** Extracts just the number from a slide label like "Page 3" or "Slide 12" — falls back to the raw label if no digits found. */
  getPageNumber(label: string): string {
    const match = (label || '').match(/\d+/);
    return match ? match[0] : (label || '');
  }
  trackByUid(_i: number, e: { uid: string }) { return e.uid; }

  // ── Drag source (from the left triage grid) ──
  onSourceDragStart(ev: DragEvent, s: CanvasSourceSlide) {
    ev.dataTransfer?.setData('text/canvas-drag', JSON.stringify({ src: 'source', pageKey: s.pageKey }));
  }
  onImportDragStart(ev: DragEvent, imp: ImportedSlide) {
    ev.dataTransfer?.setData('text/canvas-drag', JSON.stringify({ src: 'import', uid: imp.uid }));
  }

  // ── Import a PDF from disk, each page becomes a draggable tile ──
  triggerImport() { this.importInput?.nativeElement.click(); }

  async onImportFilesSelected(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;

    this.importing = true;
    this.cdr.markForCheck();
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const doc = await (pdfjsLib as any).getDocument({ data: new Uint8Array(buf) }).promise;
        for (let pn = 1; pn <= doc.numPages; pn++) {
          const page = await doc.getPage(pn);
          const viewport = page.getViewport({ scale: 1.4 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          this.imports.push({
            uid: 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            name: `${file.name} · p${pn}`,
            thumb: canvas.toDataURL('image/png'),
            comments: []
          });
        }
      } catch (e) {
        console.error('PDF import failed:', e);
      }
    }
    this.importing = false;
    this.cdr.markForCheck();
  }

  // ============================================================
  // RIGHT PANEL — the canvas itself
  // ============================================================

  canvasTiles: CanvasTile[] = [];
  private canUid = 1;
  canvasView: CanvasViewMode = 'grid';
  tileSize = 130; // px, drives grid column width
  locked = false;
  private canvasExclusions = new Set<string>();

  get canvasStatusText(): string {
    if (!this.canvasTiles.length) return 'Canvas empty.';
    return `${this.canvasTiles.length} slide(s)` + (this.locked ? ' · LOCKED, ready for API run' : ' · drag between slides to reorder');
  }

  isCanvasSelected(uid: string): boolean { return !this.canvasExclusions.has(uid); }
  setCanvasSelected(uid: string, on: boolean) {
    if (on) this.canvasExclusions.delete(uid); else this.canvasExclusions.add(uid);
  }
  get selectedCanvasCount(): number {
    return this.canvasTiles.filter(t => this.isCanvasSelected(t.uid)).length;
  }
  selectAllCanvas(on: boolean) {
    this.canvasExclusions.clear();
    if (!on) this.canvasTiles.forEach(t => this.canvasExclusions.add(t.uid));
  }

  setCanvasView(v: CanvasViewMode) { this.canvasView = v; }

  // ── Drop handling: dropping onto empty canvas area appends at the end ──
  dragHover = false;
  onCanvasDragOver(ev: DragEvent) { ev.preventDefault(); this.dragHover = true; }
  onCanvasDragLeave() { this.dragHover = false; }
  onCanvasDrop(ev: DragEvent) {
    ev.preventDefault();
    this.dragHover = false;
    if (this.locked) return;
    const data = this.readDragData(ev);
    if (!data || data.canUid) return; // re-drops of existing tiles are handled per-tile
    this.addTileAt(data, this.canvasTiles.length);
  }

  private readDragData(ev: DragEvent): any {
    try { return JSON.parse(ev.dataTransfer?.getData('text/canvas-drag') || '{}'); }
    catch { return null; }
  }

  private addTileAt(data: any, index: number) {
    let tile: CanvasTile | null = null;
    if (data.src === 'import') {
      const imp = this.imports.find(i => i.uid === data.uid);
      if (!imp) return;
      tile = { uid: 'k' + (this.canUid++), thumb: imp.thumb, rot: 0, src: 'import', importUid: imp.uid };
    } else if (data.src === 'source') {
      const s = this.slides.find(x => x.pageKey === data.pageKey);
      if (!s) return;
      tile = { uid: 'k' + (this.canUid++), thumb: s.thumb, rot: 0, src: 'source', pageKey: s.pageKey, label: s.label };
    }
    if (!tile) return;
    index = Math.max(0, Math.min(this.canvasTiles.length, index));
    this.canvasTiles.splice(index, 0, tile);
  }

  // ── Per-tile drag/reorder (PowerPoint-style insertion) ──
  onTileDragStart(ev: DragEvent, tile: CanvasTile) {
    if (this.locked) { ev.preventDefault(); return; }
    ev.dataTransfer?.setData('text/canvas-drag', JSON.stringify({ canUid: tile.uid }));
  }
  insertSide: Record<string, 'before' | 'after' | null> = {};
  onTileDragOver(ev: DragEvent, tile: CanvasTile, index: number) {
    if (this.locked) return;
    ev.preventDefault();
    const el = ev.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const after = this.canvasView === 'list'
      ? (ev.clientY > r.top + r.height / 2)
      : (ev.clientX > r.left + r.width / 2);
    this.insertSide[tile.uid] = after ? 'after' : 'before';
  }
  onTileDragLeave(tile: CanvasTile) { this.insertSide[tile.uid] = null; }
  onTileDrop(ev: DragEvent, tile: CanvasTile, index: number) {
    if (this.locked) return;
    ev.preventDefault();
    ev.stopPropagation();
    const after = this.insertSide[tile.uid] === 'after';
    this.insertSide[tile.uid] = null;
    const targetIndex = index + (after ? 1 : 0);
    const data = this.readDragData(ev);
    if (!data) return;
    if (data.canUid) {
      this.moveTileTo(data.canUid, targetIndex);
    } else {
      this.addTileAt(data, targetIndex);
    }
  }

  private moveTileTo(uid: string, index: number) {
    const fromIndex = this.canvasTiles.findIndex(t => t.uid === uid);
    if (fromIndex < 0) return;
    const [moved] = this.canvasTiles.splice(fromIndex, 1);
    if (fromIndex < index) index--;
    index = Math.max(0, Math.min(this.canvasTiles.length, index));
    this.canvasTiles.splice(index, 0, moved);
  }

  rotateTile(tile: CanvasTile) { tile.rot = (tile.rot + 90) % 360; }
  removeTile(uid: string) { this.canvasTiles = this.canvasTiles.filter(t => t.uid !== uid); }

  clearCanvas() {
    if (!this.canvasTiles.length) return;
    if (!confirm('Clear canvas?')) return;
    this.canvasTiles = [];
    this.locked = false;
  }

  toggleFinalise() {
    if (!this.canvasTiles.length) return;
    this.locked = !this.locked;
  }

  // ── Zoom / preview modal ──
  zoomOpen = false;
  zoomImageUrl: string | null = null;
  zoomComments: { id: number; text: string; author: string | null; resolved: boolean | number }[] = [];
  zoomTitle = '';
  /** pageKey of the slide currently shown in Zoom — null for imported pages, which use zoomImportUid instead. */
  zoomPageKey: string | null = null;
  /** uid of the ImportedSlide currently shown in Zoom — null for backend-sourced slides. Comments on these are local-only. */
  zoomImportUid: string | null = null;
  private importCommentUid = 1;

  openZoomForTile(tile: CanvasTile) {
    this.zoomImageUrl = tile.thumb;
    const importSlide = tile.importUid ? this.imports.find(i => i.uid === tile.importUid) : null;
    this.zoomTitle = tile.label || importSlide?.name || 'Canvas slide';
    this.zoomPageKey = tile.pageKey || null;
    this.zoomImportUid = tile.importUid || null;
    if (tile.pageKey) {
      const source = this.slides.find(s => s.pageKey === tile.pageKey);
      this.zoomComments = source?.comments || [];
    } else if (importSlide) {
      this.zoomComments = importSlide.comments;
    } else {
      this.zoomComments = [];
    }
    this.newZoomCommentText = '';
    this.zoomOpen = true;
  }
  openZoomForSource(s: CanvasSourceSlide) {
    this.zoomImageUrl = s.thumb;
    this.zoomTitle = s.label;
    this.zoomPageKey = s.pageKey;
    this.zoomImportUid = null;
    this.zoomComments = s.comments;
    this.newZoomCommentText = '';
    this.zoomOpen = true;
  }
  closeZoom() { this.zoomOpen = false; this.zoomImageUrl = null; this.zoomPageKey = null; this.zoomImportUid = null; }

  // ── Add/edit comments — from the Zoom modal ──
  newZoomCommentText = '';

  submitZoomComment() {
    const text = this.newZoomCommentText.trim();
    if (!text) return;
    if (this.zoomImportUid) {
      // Local-only — imported slides never touch the backend.
      const imp = this.imports.find(i => i.uid === this.zoomImportUid);
      if (!imp) return;
      imp.comments.push({ id: -(this.importCommentUid++), text, author: 'You (local)', resolved: false });
      this.zoomComments = imp.comments;
      this.newZoomCommentText = '';
      return;
    }
    if (!this.zoomPageKey) return;
    this.addComment.emit({ pageKey: this.zoomPageKey, text });
    this.newZoomCommentText = '';
  }

  // ── Add/edit comments — inline on the mini triage cards ──
  /** pageKey of the mini card whose "add comment" composer is currently open. */
  activeMiniComposerKey: string | null = null;
  newMiniCommentText = '';

  openMiniComposer(s: CanvasSourceSlide, ev: Event) {
    ev.stopPropagation();
    this.activeMiniComposerKey = s.pageKey;
    this.newMiniCommentText = '';
  }
  cancelMiniComposer(ev?: Event) {
    ev?.stopPropagation();
    this.activeMiniComposerKey = null;
    this.newMiniCommentText = '';
  }
  submitMiniComment(s: CanvasSourceSlide, ev: Event) {
    ev.stopPropagation();
    const text = this.newMiniCommentText.trim();
    if (!text) return;
    this.addComment.emit({ pageKey: s.pageKey, text });
    this.activeMiniComposerKey = null;
    this.newMiniCommentText = '';
  }

  // ── Editing an existing comment's text — usable from both the mini cards and Zoom ──
  editingCommentId: number | null = null;
  editingCommentText = '';

  startEditComment(c: { id: number; text: string }, ev: Event) {
    ev.stopPropagation();
    this.editingCommentId = c.id;
    this.editingCommentText = c.text;
  }
  cancelEditComment(ev?: Event) {
    ev?.stopPropagation();
    this.editingCommentId = null;
    this.editingCommentText = '';
  }
  saveEditComment(ev: Event) {
    ev.stopPropagation();
    const text = this.editingCommentText.trim();
    if (!text || this.editingCommentId == null) return;
    if (this.editingCommentId < 0) {
      // Local-only comment (belongs to an imported slide) — never sent to the backend.
      for (const imp of this.imports) {
        const c = imp.comments.find(cm => cm.id === this.editingCommentId);
        if (c) { c.text = text; break; }
      }
    } else {
      this.editComment.emit({ commentId: this.editingCommentId, text });
    }
    this.editingCommentId = null;
    this.editingCommentText = '';
  }

  // ============================================================
  // EXPORT PDF
  // ============================================================

  exporting = false;

  async exportCanvasPdf() {
    if (!this.canvasTiles.length) return;
    this.exporting = true;
    this.cdr.markForCheck();
    try {
      const pageWidthPt = 595; // A4-ish width

      // Render every tile's canvas up front. Doing this before touching jsPDF
      // avoids interleaving async image loads with page creation, which is
      // what was causing an extra blank page to appear after page 1.
      const rendered: { canvas: HTMLCanvasElement; heightPt: number }[] = [];
      for (const tile of this.canvasTiles) {
        const canvas = await this.rotatedCanvasFor(tile);
        if (!canvas) continue;
        rendered.push({ canvas, heightPt: (canvas.height / canvas.width) * pageWidthPt });
      }
      if (!rendered.length) return;

      // jsPDF's constructor always creates one implicit blank page sized to
      // the `format` we pass. Rather than trying to reuse it (which is what
      // produced the stray blank page — its size doesn't reliably match a
      // landscape first slide), we explicitly add every real page ourselves
      // and then delete that implicit page 1 once the document is built.
      const pdf = new jsPDF({ unit: 'pt', format: [pageWidthPt, rendered[0].heightPt] });
      rendered.forEach((r, i) => {
        pdf.addPage([pageWidthPt, r.heightPt], r.heightPt > pageWidthPt ? 'p' : 'l');
        pdf.setPage(i + 2); // page 1 is jsPDF's implicit blank page; our pages start at index 2
        pdf.addImage(r.canvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidthPt, r.heightPt, undefined, 'FAST');
      });
      pdf.deletePage(1); // drop the implicit blank first page now that real pages exist

      const safeName = (this.topicName || 'canvas').replace(/[^\w\-]+/g, '_');
      pdf.save(`${safeName}_canvas.pdf`);
    } catch (e) {
      console.error('Canvas export failed:', e);
    } finally {
      this.exporting = false;
      this.cdr.markForCheck();
    }
  }

  /** Renders a tile's image at its stored rotation onto an offscreen canvas. */
  private rotatedCanvasFor(tile: CanvasTile): Promise<HTMLCanvasElement | null> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const rot = ((tile.rot % 360) + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const w = img.naturalWidth, h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = swap ? h : w;
        canvas.height = swap ? w : h;
        const ctx = canvas.getContext('2d')!;
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(img, -w / 2, -h / 2);
        ctx.restore();
        resolve(canvas);
      };
      img.onerror = () => resolve(null);
      img.src = tile.thumb;
    });
  }

  // ============================================================
  // OPENAI API / RUN API X & AI SLIDES MANAGEMENT
  // ============================================================

  readonly aiDisabledTitle = 'AI processing is not available yet in this screen.';
  openaiKey = '';
  runningApi = false;
  stopApiRequested = false;
  apiProgressText = '';
  targetDirHandle: any = null;
  targetFolderName = '';
  fetchingAiSlides = false;

  // Stage 1 AI Generation & Promotion State
  runningStage1 = false;
  stage1SingleLoading: { [pageKey: string]: boolean } = {};
  previewModalImg: string | null = null;

  /** Helper to call OpenAI Image Edits API for a single image with prompt text */
  private async callOpenAiImageEdits(dataUrl: string, promptText: string): Promise<string> {
    this.openaiKey = localStorage.getItem('vmss_key') || '';
    if (!this.openaiKey.trim()) {
      const inputKey = prompt('Please enter your OpenAI API key (will be saved locally):');
      if (!inputKey || !inputKey.trim()) {
        throw new Error('OpenAI API Key is required.');
      }
      this.openaiKey = inputKey.trim();
      localStorage.setItem('vmss_key', this.openaiKey);
    }

    const pngBlob = await this.dataURLtoPngBlob(dataUrl);
    const fd = new FormData();
    fd.append('model', 'gpt-image-2');
    fd.append('prompt', promptText);
    fd.append('image', pngBlob, 'slide.png');

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
        if (errObj.error?.message) errMsg = errObj.error.message;
      } catch {}
      throw new Error(`OpenAI API Error (${res.status}): ${errMsg}`);
    }

    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json || data.data?.[0]?.url;
    if (!b64) throw new Error('API returned empty image data.');

    if (!b64.startsWith('http') && !b64.startsWith('data:')) {
      return 'data:image/png;base64,' + b64;
    }
    return b64;
  }

  /** "Make this" — Generate AI slide for a single Stage 1 commented slide */
  async makeSingleSlideStage1(slide: CanvasSourceSlide) {
    if (this.stage1SingleLoading[slide.pageKey]) return;
    this.stage1SingleLoading[slide.pageKey] = true;
    this.cdr.markForCheck();

    try {
      const commentTexts = (slide.comments || []).map(c => c.text?.trim()).filter(Boolean);
      const promptText = commentTexts.length > 0 
        ? `Modify and apply these changes to the slide: ${commentTexts.join('; ')}.`
        : 'Enhance and edit this educational slide presentation with modern graphics and typography.';

      this.toast.show(`Generating AI slide for ${slide.label || 'slide'}...`, 'info');
      const generatedImg = await this.callOpenAiImageEdits(slide.thumb, promptText);

      slide.aiGeneratedThumb = generatedImg;
      this.toast.success(`Generated AI slide for ${slide.label}!`);

      // Persist to backend database
      this.saveCurrentAiSlidesToDb();
    } catch (err: any) {
      console.error('Single Stage 1 generation failed:', err);
      this.toast.error(err.message || 'Stage 1 slide generation failed.');
    } finally {
      this.stage1SingleLoading[slide.pageKey] = false;
      this.cdr.markForCheck();
    }
  }

  /** "Run Stage 1" — Batch generate AI slides for all Stage 1 commented slides */
  async runStage1Batch() {
    const slidesToProcess = this.commented;
    if (!slidesToProcess.length) {
      this.toast.show('No Stage 1 commented slides available to process.', 'info');
      return;
    }

    this.runningStage1 = true;
    this.cdr.markForCheck();
    let count = 0;

    try {
      for (let i = 0; i < slidesToProcess.length; i++) {
        const slide = slidesToProcess[i];
        this.toast.show(`Stage 1 processing slide ${i + 1} of ${slidesToProcess.length}...`, 'info');

        const commentTexts = (slide.comments || []).map(c => c.text?.trim()).filter(Boolean);
        const promptText = commentTexts.length > 0 
          ? `Modify and apply these changes to the slide: ${commentTexts.join('; ')}.`
          : 'Enhance and edit this educational slide presentation with modern graphics and typography.';

        const generatedImg = await this.callOpenAiImageEdits(slide.thumb, promptText);
        slide.aiGeneratedThumb = generatedImg;
        count++;
        this.cdr.markForCheck();
      }

      if (count > 0) {
        this.toast.success(`Stage 1 completed for ${count} slide(s)!`);
        this.saveCurrentAiSlidesToDb();
      }
    } catch (err: any) {
      console.error('Stage 1 batch processing failed:', err);
      this.toast.error(err.message || 'Stage 1 processing failed.');
    } finally {
      this.runningStage1 = false;
      this.cdr.markForCheck();
    }
  }

  /** "Move to Stage-2" — Promote a generated Stage 1 slide to Stage-2 .GPT Final section */
  moveToStage2(slide: CanvasSourceSlide) {
    if (!slide.aiGeneratedThumb) {
      this.toast.show('No generated AI image available for this slide.', 'info');
      return;
    }
    slide.thumb = slide.aiGeneratedThumb;
    slide.isFinal = true;
    this.toast.success(`Moved slide "${slide.label}" to Stage-2 .GPT Final section!`);
    this.cdr.markForCheck();
  }

  /** "Move all AI to Stage-2" — Move all generated Stage 1 AI slides to Stage-2 at once */
  moveAllAiSlidesToStage2() {
    const aiSlides = this.commented.filter(s => !!s.aiGeneratedThumb);
    if (!aiSlides.length) {
      this.toast.show('No AI generated slides available in Stage 1 to move.', 'info');
      return;
    }
    aiSlides.forEach(s => {
      s.thumb = s.aiGeneratedThumb!;
      s.isFinal = true;
    });
    this.toast.success(`Moved ${aiSlides.length} AI generated slide(s) to Stage-2 .GPT!`);
    this.cdr.markForCheck();
  }

  runningStage2 = false;

  /** "Run Stage 2" — Generate AI slides for Stage-2 final slides one by one using ONLY the universal prompt */
  async runStage2Batch() {
    const finalSlides = this.finals;
    if (!finalSlides.length) {
      this.toast.show('No Stage-2 final slides available to process.', 'info');
      return;
    }

    const promptText = (this.selectedVaultPromptBody || '').trim();
    if (!promptText) {
      this.toast.show('Please select a universal prompt template from the dropdown first.', 'info');
      return;
    }

    this.runningStage2 = true;
    this.cdr.markForCheck();
    let count = 0;

    try {
      for (let i = 0; i < finalSlides.length; i++) {
        const slide = finalSlides[i];
        this.toast.show(`Stage 2 processing slide ${i + 1} of ${finalSlides.length} with universal prompt...`, 'info');

        // IMPORTANT: Only universal prompt text is sent (slide comments are NOT included)
        const generatedImg = await this.callOpenAiImageEdits(slide.thumb, promptText);
        slide.thumb = generatedImg;
        slide.aiGeneratedThumb = generatedImg;
        count++;
        this.cdr.markForCheck();
      }

      if (count > 0) {
        this.toast.success(`Stage 2 completed for ${count} final slide(s)!`);
        this.saveCurrentAiSlidesToDb();
      }
    } catch (err: any) {
      console.error('Stage 2 batch processing failed:', err);
      this.toast.error(err.message || 'Stage 2 processing failed.');
    } finally {
      this.runningStage2 = false;
      this.cdr.markForCheck();
    }
  }

  /** "Move all to Canvas" — Transfer all Stage-2 final slides into right Canvas section */
  moveAllStage2ToCanvas() {
    const finalSlides = this.finals;
    if (!finalSlides.length) {
      this.toast.show('No Stage-2 final slides to move to Canvas.', 'info');
      return;
    }

    const existingThumbs = new Set(this.canvasTiles.map(t => t.thumb));
    const newTiles: CanvasTile[] = [];

    finalSlides.forEach((s, idx) => {
      if (!existingThumbs.has(s.thumb)) {
        newTiles.push({
          uid: 'final_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).substring(2, 5),
          thumb: s.thumb,
          rot: 0,
          src: 'source',
          pageKey: s.pageKey,
          label: s.label || `Final Slide ${idx + 1}`
        });
      }
    });

    if (newTiles.length > 0) {
      this.canvasTiles = [...this.canvasTiles, ...newTiles];
      this.toast.success(`Added ${newTiles.length} Stage-2 final slide(s) to Canvas!`);
    } else {
      this.toast.show('All Stage-2 final slides are already on the Canvas.', 'info');
    }
    this.cdr.markForCheck();
  }

  /** Save all active generated AI slides to backend database */
  private saveCurrentAiSlidesToDb() {
    const allGeneratedSlides: any[] = [];

    this.slides.forEach((s, idx) => {
      if (s.aiGeneratedThumb) {
        allGeneratedSlides.push({
          index: idx + 1,
          label: s.label || `Slide ${idx + 1}`,
          thumb: s.aiGeneratedThumb
        });
      }
    });

    this.canvasTiles.forEach((t, idx) => {
      if (t.thumb && (t.thumb.startsWith('data:') || t.thumb.includes('ai_slides/'))) {
        allGeneratedSlides.push({
          index: allGeneratedSlides.length + 1,
          label: t.label || `Canvas Slide ${idx + 1}`,
          thumb: t.thumb
        });
      }
    });

    if (!allGeneratedSlides.length) return;

    const safeName = (this.topicName || 'canvas').replace(/[^\w\-]+/g, '_');
    const savePayload = {
      topic_name: this.topicName || safeName,
      slides: allGeneratedSlides,
      pdf_url: `${safeName}_AI_Slides.pdf`
    };

    this.api.post('/topics/save-ai-slides', savePayload).subscribe({
      next: (res: any) => {
        if (res?.status) {
          console.log('[AI Slides DB] Saved successfully to DB:', res);
        }
      },
      error: (err: any) => console.error('[AI Slides DB] Failed to save slides to DB:', err)
    });
  }

  /** Preview Modal controls */
  openGeneratedPreview(imgUrl: string) {
    this.previewModalImg = imgUrl;
    this.cdr.markForCheck();
  }
  closeGeneratedPreview() {
    this.previewModalImg = null;
    this.cdr.markForCheck();
  }

  /** Convert data URL to PNG blob for FormData upload */
  private async dataURLtoPngBlob(dataUrl: string): Promise<Blob> {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  /** Pick target output folder for local downloads using File System Access API */
  async pickTargetFolder() {
    if (!(window as any).showDirectoryPicker) {
      this.toast.show('DirectoryPicker is not supported on this browser (Chrome/Edge recommended). Storing files via default downloads.', 'info');
      return;
    }
    try {
      const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      this.targetDirHandle = dir;
      this.targetFolderName = dir.name;
      this.toast.success(`Selected output folder: ${dir.name}`);
      this.cdr.markForCheck();
    } catch (e) {
      // User cancelled picker
    }
  }

  /** Save file locally to chosen folder or via browser download */
  private async saveFileLocally(filename: string, blob: Blob) {
    if (this.targetDirHandle) {
      try {
        const fileHandle = await this.targetDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        this.toast.success(`Saved file to folder: ${filename}`);
        return;
      } catch (err: any) {
        console.warn('Failed to save to selected folder, falling back to browser download:', err);
      }
    }
    // Fallback: standard browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Prompt Vault V2 integration
  vaultPrompts: any[] = [];
  selectedVaultPromptId = '';
  selectedVaultPromptBody = '';
  showPromptModal = false;

  loadVaultPrompts() {
    const headers = new HttpHeaders({
      'VidyaMine': 'vidyamine',
      'Production': 'doot'
    });
    this.http.get<any>('https://rest.vidyamine.com/rest/dev/vm_doot/prompt-vault-v2/', { headers }).subscribe({
      next: (res) => {
        if (res?.status && Array.isArray(res.data)) {
          this.vaultPrompts = res.data;
          this.cdr.markForCheck();
        }
      },
      error: (err) => {
        console.error('Failed to load vault prompts:', err);
      }
    });
  }

  onVaultPromptSelect(event: any) {
    const promptId = event.target.value;
    this.selectedVaultPromptId = promptId;

    if (!promptId || promptId === 'none') {
      this.selectedVaultPromptBody = '';
      this.selectedVaultPromptId = '';
      this.toast.show('Prompt template unselected & cleared', 'info');
      this.cdr.markForCheck();
      return;
    }

    const p = this.vaultPrompts.find(item => item.id == promptId);
    if (p && p.body) {
      this.selectedVaultPromptBody = p.body.trim();
      this.toast.success(`Prompt "${p.name}" selected!`);
      this.cdr.markForCheck();
    } else {
      this.toast.error('Selected prompt has no text body.');
    }
  }

  togglePromptModal() {
    this.showPromptModal = !this.showPromptModal;
    this.cdr.markForCheck();
  }

  /** Extract all text comments for a given tile */
  private extractCommentsForTile(tile: CanvasTile): string {
    let commentsList: { text: string }[] = [];
    if (tile.src === 'source' && tile.pageKey) {
      const source = this.slides.find(s => s.pageKey === tile.pageKey);
      if (source) commentsList = source.comments || [];
    } else if (tile.src === 'import' && tile.importUid) {
      const imp = this.imports.find(i => i.uid === tile.importUid);
      if (imp) commentsList = imp.comments || [];
    }

    const commentTexts = commentsList.map(c => c.text?.trim()).filter(Boolean);

    // Stage 1 · Claude (Commented slides): use ONLY their own slide comments
    if (commentTexts.length > 0) {
      return `Modify and apply these changes to the slide: ${commentTexts.join('; ')}.`;
    }

    // Stage-2 .GPT (Final slides): apply the universal prompt template
    const vaultInstructions = this.selectedVaultPromptBody ? this.selectedVaultPromptBody.trim() : '';
    if (vaultInstructions) {
      return vaultInstructions;
    }

    return 'Enhance and edit this educational slide presentation with modern graphics and typography.';
  }

  /** Stop processing the current Run API X queue */
  stopRunApi() {
    this.stopApiRequested = true;
    this.toast.show('Stopping API run requests...', 'info');
  }

  /** Main Run API X execution function */
  async runApiX() {
    if (!this.canvasTiles.length) {
      this.toast.show('No canvas slides to process.', 'info');
      return;
    }

    // 1. Check OpenAI API Key
    this.openaiKey = localStorage.getItem('vmss_key') || '';
    if (!this.openaiKey.trim()) {
      const inputKey = prompt('Please enter your OpenAI API key (will be saved locally):');
      if (!inputKey || !inputKey.trim()) {
        this.toast.error('OpenAI API Key is required to run AI edit API.');
        return;
      }
      this.openaiKey = inputKey.trim();
      localStorage.setItem('vmss_key', this.openaiKey);
    }

    // 2. Select tiles to process (only selected ones if checkbox is filtered, or all)
    const selectedTiles = this.canvasTiles.filter(t => this.isCanvasSelected(t.uid));
    if (!selectedTiles.length) {
      this.toast.show('No slides selected for API run.', 'info');
      return;
    }

    this.runningApi = true;
    this.stopApiRequested = false;
    this.cdr.markForCheck();

    let processedCount = 0;

    try {
      for (let i = 0; i < selectedTiles.length; i++) {
        if (this.stopApiRequested) {
          this.toast.show(`API run stopped by user after processing ${processedCount} slide(s).`, 'info');
          break;
        }

        const tile = selectedTiles[i];
        this.apiProgressText = `Processing slide ${i + 1} of ${selectedTiles.length} via OpenAI...`;
        this.toast.show(this.apiProgressText);
        this.cdr.markForCheck();

        const promptText = this.extractCommentsForTile(tile);
        const pngBlob = await this.dataURLtoPngBlob(tile.thumb);

        const fd = new FormData();
        fd.append('model', 'gpt-image-2');
        fd.append('prompt', promptText);
        fd.append('image', pngBlob, `slide_${i + 1}.png`);

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
            if (errObj.error?.message) errMsg = errObj.error.message;
          } catch {}
          throw new Error(`OpenAI API Error (${res.status}): ${errMsg}`);
        }

        const data = await res.json();
        const b64 = data.data?.[0]?.b64_json || data.data?.[0]?.url;
        if (!b64) throw new Error('API returned empty image data.');

        let displayUrl = b64;
        if (!b64.startsWith('http') && !b64.startsWith('data:')) {
          displayUrl = 'data:image/png;base64,' + b64;
        }

        // Update tile thumb with new AI edited slide image
        tile.thumb = displayUrl;
        tile.rot = 0;
        processedCount++;
        this.cdr.markForCheck();
      }

      if (processedCount > 0) {
        this.toast.success(`Successfully generated AI slides for ${processedCount} slide(s)!`);

        // 3. Build & export final combined PDF
        const safeName = (this.topicName || 'canvas').replace(/[^\w\-]+/g, '_');
        const pdfFileName = `${safeName}_AI_Slides.pdf`;

        // Render PDF pages
        const pageWidthPt = 595;
        const rendered: { canvas: HTMLCanvasElement; heightPt: number }[] = [];
        for (const tile of this.canvasTiles) {
          const canvas = await this.rotatedCanvasFor(tile);
          if (!canvas) continue;
          rendered.push({ canvas, heightPt: (canvas.height / canvas.width) * pageWidthPt });
        }

        if (rendered.length > 0) {
          const pdf = new jsPDF({ unit: 'pt', format: [pageWidthPt, rendered[0].heightPt] });
          rendered.forEach((r, idx) => {
            pdf.addPage([pageWidthPt, r.heightPt], r.heightPt > pageWidthPt ? 'p' : 'l');
            pdf.setPage(idx + 2);
            pdf.addImage(r.canvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidthPt, r.heightPt, undefined, 'FAST');
          });
          pdf.deletePage(1);

          const pdfArrayBuffer = pdf.output('arraybuffer');
          const pdfBlob = new Blob([pdfArrayBuffer], { type: 'application/pdf' });

          // 4. Save PDF locally
          await this.saveFileLocally(pdfFileName, pdfBlob);

          // 5. Save generated slides to Backend Database
          const slideThumbs = this.canvasTiles.map((t, idx) => ({
            index: idx + 1,
            label: t.label || `Slide ${idx + 1}`,
            thumb: t.thumb
          }));

          const savePayload = {
            topic_name: this.topicName || safeName,
            slides: slideThumbs,
            pdf_url: pdfFileName
          };
          console.log('[Run API X] Posting save-ai-slides payload to backend:', savePayload);

          this.api.post('/topics/save-ai-slides', savePayload).subscribe({
            next: (saveRes: any) => {
              console.log('[Run API X] Save response from backend:', saveRes);
              if (saveRes?.status) {
                this.toast.success('AI slides saved to database successfully!');
              } else {
                console.warn('[Run API X] Backend save warning:', saveRes);
              }
            },
            error: (err: any) => {
              console.error('[Run API X] Failed to save AI slides to backend:', err);
            }
          });

          // 6. Web Speech API Announcement calling short file name
          const shortName = safeName.slice(0, 8);
          const speechText = `${shortName} file is ready.`;
          if ('speechSynthesis' in window) {
            try {
              window.speechSynthesis.cancel();
              const utterance = new SpeechSynthesisUtterance(speechText);
              utterance.rate = 1.0;
              window.speechSynthesis.speak(utterance);
            } catch (spErr) {
              console.warn('Speech synthesis error:', spErr);
            }
          }
        }
      }
    } catch (err: any) {
      console.error('Run API X failed:', err);
      this.toast.error(err.message || 'Run API X failed.');
    } finally {
      this.runningApi = false;
      this.apiProgressText = '';
      this.cdr.markForCheck();
    }
  }

  readonly SERVER_BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm/';

  private extractSlidesFromResponse(res: any): any[] {
    if (!res) return [];

    const tryExtract = (obj: any): any[] => {
      if (!obj) return [];
      if (Array.isArray(obj)) return obj;
      if (Array.isArray(obj.slides)) return obj.slides;
      if (Array.isArray(obj.data)) return obj.data;
      if (Array.isArray(obj.data?.slides)) return obj.data.slides;
      if (typeof obj === 'string') {
        try {
          const parsed = JSON.parse(obj);
          return tryExtract(parsed);
        } catch {}
      }
      return [];
    };

    let list = tryExtract(res.data);
    if (!list || list.length === 0) list = tryExtract(res.slides);
    if (!list || list.length === 0) list = tryExtract(res.result);
    if (!list || list.length === 0) list = tryExtract(res);

    if (!list || list.length === 0) {
      const jsonStr = JSON.stringify(res);
      const matches = jsonStr.match(/(?:ai_slides\/[^\s"'\\]+|data:image\/[a-zA-Z]+;base64,[^\s"'\\]+)/g);
      if (matches && matches.length > 0) {
        return matches.map((url, i) => ({ thumb: url, label: `AI Slide ${i + 1}` }));
      }
    }

    return list || [];
  }

  /** Fetch AI generated slides from server database */
  fetchAiSlides() {
    console.log('[Fetch AI Slides] Called. current topicName:', this.topicName);
    if (!this.topicName) {
      this.toast.show('No topic context available to fetch AI slides.', 'info');
      return;
    }
    this.fetchingAiSlides = true;
    this.cdr.markForCheck();

    const apiPath = `/topics/get-ai-slides?topic_name=${encodeURIComponent(this.topicName)}`;
    console.log('[Fetch AI Slides] Sending GET request to:', apiPath);

    this.api.get<any>(apiPath).subscribe({
      next: (res: any) => {
        this.fetchingAiSlides = false;
        console.log('[Fetch AI Slides] Server Response Received:', res);

        const slidesList = this.extractSlidesFromResponse(res);
        console.log('[Fetch AI Slides] Extracted slidesList array:', slidesList);

        if (slidesList.length > 0) {
          const existingThumbs = new Set(this.canvasTiles.map(t => t.thumb));
          const newFetchedTiles: CanvasTile[] = [];

          slidesList.forEach((s: any, i: number) => {
            let imgUrl = typeof s === 'string' ? s : (s.thumb || s.url || s.image_url || s.path || '');
            if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('data:')) {
              imgUrl = this.SERVER_BASE + imgUrl.replace(/^\/+/, '');
            }

            if (!existingThumbs.has(imgUrl)) {
              newFetchedTiles.push({
                uid: 'ai_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 5),
                thumb: imgUrl,
                rot: 0,
                src: 'import',
                label: (typeof s === 'object' && s.label) ? s.label : `AI Slide ${this.canvasTiles.length + newFetchedTiles.length + 1}`
              });
            }
          });

          if (newFetchedTiles.length > 0) {
            this.canvasTiles = [...this.canvasTiles, ...newFetchedTiles];
            this.toast.success(`Fetched & added ${newFetchedTiles.length} new AI slide(s) to canvas!`);
          } else {
            this.toast.show('All fetched AI slides are already present on canvas.', 'info');
          }
        } else {
          console.warn('[Fetch AI Slides] No slides found in response:', res);
          const msg = res?.message || res?.data?.message || `No AI slides found for topic "${this.topicName}".`;
          this.toast.show(msg, 'info');
        }
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        this.fetchingAiSlides = false;
        console.error('[Fetch AI Slides] API Error:', err);
        this.toast.error('Failed to fetch AI slides from server.');
        this.cdr.markForCheck();
      }
    });
  }

  // ============================================================
  // IMAGE EDITOR — rotate / flip / invert / brightness / contrast /
  // draw / crop / text / shapes. Runs entirely client-side against
  // a single canvas tile; "Save" writes the composited PNG back onto
  // the tile so it appears finalized on the canvas.
  // ============================================================

  editorOpen = false;
  private editorTargetUid: string | null = null;
  private editorBase = new Image();
  editorRotate = 0;
  editorFlipH = false;
  editorFlipV = false;
  editorInvert = false;
  editorAngle = 0;
  editorBrightness = 100;
  editorContrast = 100;
  editorDrawMode = false;
  editorCropMode = false;
  /** When set, the next click+drag on the canvas draws a shape of this kind at the cursor position (MS-Paint style) instead of inserting one at a fixed spot. */
  editorShapePlaceMode: 'rect' | 'ellipse' | 'arrow' | null = null;
  /** When true, the next click on the canvas opens a small inline text box positioned exactly where the user clicked. */
  editorTextPlaceMode = false;
  private shapeDragStart: { x: number; y: number } | null = null;
  private draftShape: { kind: 'rect' | 'ellipse' | 'arrow'; x: number; y: number; w: number; h: number; color: string } | null = null;
  /** Inline text-entry box shown at a canvas position after clicking with Text mode active. Screen (CSS) coords for positioning the overlay input; canvas coords for baking into the image. */
  editorTextEntry: { screenX: number; screenY: number; canvasX: number; canvasY: number; value: string } | null = null;
  editorPenColor = '#c8443a';
  editorPenWidth = 4;
  private strokes: { color: string; width: number; points: { x: number; y: number }[] }[] = [];
  private currentStroke: { color: string; width: number; points: { x: number; y: number }[] } | null = null;
  private cropRect: { x: number; y: number; w: number; h: number } | null = null;
  private cropDragStart: { x: number; y: number } | null = null;
  private texts: { text: string; x: number; y: number; size: number; color: string }[] = [];
  private shapes: { kind: 'rect' | 'ellipse' | 'arrow'; x: number; y: number; w: number; h: number; color: string }[] = [];
  editorHint = '';

  // ── Undo / redo ──
  /** Snapshot of everything a single editor action can change. Pushed after each committed action (not while dragging). */
  private editorUndoStack: EditorSnapshot[] = [];
  private editorRedoStack: EditorSnapshot[] = [];
  get canEditorUndo(): boolean { return this.editorUndoStack.length > 0; }
  get canEditorRedo(): boolean { return this.editorRedoStack.length > 0; }

  private snapshotEditorState(): EditorSnapshot {
    return {
      rotate: this.editorRotate, flipH: this.editorFlipH, flipV: this.editorFlipV, invert: this.editorInvert,
      angle: this.editorAngle, brightness: this.editorBrightness, contrast: this.editorContrast,
      strokes: this.strokes.map(s => ({ ...s, points: s.points.map(p => ({ ...p })) })),
      shapes: this.shapes.map(s => ({ ...s })),
      texts: this.texts.map(t => ({ ...t })),
      cropRect: this.cropRect ? { ...this.cropRect } : null
    };
  }
  private applyEditorSnapshot(s: EditorSnapshot) {
    this.editorRotate = s.rotate; this.editorFlipH = s.flipH; this.editorFlipV = s.flipV; this.editorInvert = s.invert;
    this.editorAngle = s.angle; this.editorBrightness = s.brightness; this.editorContrast = s.contrast;
    this.strokes = s.strokes.map(st => ({ ...st, points: st.points.map(p => ({ ...p })) }));
    this.shapes = s.shapes.map(sh => ({ ...sh }));
    this.texts = s.texts.map(t => ({ ...t }));
    this.cropRect = s.cropRect ? { ...s.cropRect } : null;
  }
  /** Call right after any action that should be a single undo step (rotate, flip, invert, finished stroke/shape/text, slider release, crop apply). Clears redo, matching standard undo/redo behavior. */
  private pushEditorHistory() {
    this.editorUndoStack.push(this.snapshotEditorState());
    if (this.editorUndoStack.length > 50) this.editorUndoStack.shift(); // cap memory use
    this.editorRedoStack = [];
  }
  editorUndo() {
    if (!this.editorUndoStack.length) return;
    this.editorRedoStack.push(this.snapshotEditorState());
    const prev = this.editorUndoStack.pop()!;
    this.applyEditorSnapshot(prev);
    this.renderEditor();
  }
  editorRedo() {
    if (!this.editorRedoStack.length) return;
    this.editorUndoStack.push(this.snapshotEditorState());
    const next = this.editorRedoStack.pop()!;
    this.applyEditorSnapshot(next);
    this.renderEditor();
  }

  openEditorForTile(tile: CanvasTile) {
    this.editorTargetUid = tile.uid;
    this.resetEditorState();
    const img = new Image(); // fresh element each time — avoids stale onload/cache races on the shared instance
    img.onload = () => {
      this.editorBase = img;
      this.editorOpen = true;
      this.cdr.detectChanges(); // ensure #editorCanvas exists in the DOM before we try to draw into it
      this.renderEditor();
    };
    img.onerror = () => { this.editorHint = 'Failed to load slide image.'; };
    img.src = tile.thumb;
  }

  private resetEditorState() {
    this.editorRotate = 0; this.editorFlipH = false; this.editorFlipV = false; this.editorInvert = false;
    this.editorAngle = 0; this.editorBrightness = 100; this.editorContrast = 100;
    this.editorDrawMode = false; this.editorCropMode = false;
    this.editorShapePlaceMode = null; this.editorTextPlaceMode = false;
    this.shapeDragStart = null; this.draftShape = null; this.editorTextEntry = null;
    this.strokes = []; this.currentStroke = null; this.cropRect = null; this.cropDragStart = null;
    this.texts = []; this.shapes = []; this.editorHint = '';
    this.editorUndoStack = []; this.editorRedoStack = [];
  }

  closeEditor() { this.editorOpen = false; this.editorTargetUid = null; }

  editorRotate90(delta: number) { this.pushEditorHistory(); this.editorRotate = (this.editorRotate + delta + 360) % 360; this.renderEditor(); }
  editorFlip(axis: 'h' | 'v') {
    this.pushEditorHistory();
    if (axis === 'h') this.editorFlipH = !this.editorFlipH; else this.editorFlipV = !this.editorFlipV;
    this.renderEditor();
  }
  editorToggleInvert() { this.pushEditorHistory(); this.editorInvert = !this.editorInvert; this.renderEditor(); }
  editorToggleDraw() {
    this.editorDrawMode = !this.editorDrawMode;
    if (this.editorDrawMode) { this.editorCropMode = false; this.editorShapePlaceMode = null; this.cancelTextPlacement(); }
    this.editorHint = this.editorDrawMode ? 'Draw: drag on the slide' : '';
  }
  editorToggleCrop() {
    this.editorCropMode = !this.editorCropMode;
    if (this.editorCropMode) { this.editorDrawMode = false; this.editorShapePlaceMode = null; this.cancelTextPlacement(); }
    this.editorHint = this.editorCropMode ? 'Crop: drag a rectangle, then Save' : '';
    this.cropRect = null;
    this.renderEditor();
  }
  /** Arms text-placement mode: the next click on the canvas opens an inline text box right there. */
  editorAddText() {
    this.editorTextPlaceMode = !this.editorTextPlaceMode;
    if (this.editorTextPlaceMode) { this.editorDrawMode = false; this.editorCropMode = false; this.editorShapePlaceMode = null; }
    this.editorHint = this.editorTextPlaceMode ? 'Text: click anywhere on the slide to place it' : '';
  }
  private cancelTextPlacement() { this.editorTextPlaceMode = false; this.editorTextEntry = null; }
  /** Arms shape-placement mode: the next click+drag on the canvas draws the shape there, like MS Paint. */
  editorAddShape(kind: 'rect' | 'ellipse' | 'arrow') {
    this.editorShapePlaceMode = this.editorShapePlaceMode === kind ? null : kind;
    if (this.editorShapePlaceMode) { this.editorDrawMode = false; this.editorCropMode = false; this.cancelTextPlacement(); }
    this.editorHint = this.editorShapePlaceMode ? 'Shape: click and drag on the slide to draw it' : '';
  }
  editorReset() { this.resetEditorState(); this.renderEditor(); }

  /** True while a range slider is mid-drag — used so we push exactly one undo step per drag gesture, not one per pixel of movement. */
  private rangeHistoryArmed = false;
  onEditorRangeInput(field: 'angle' | 'brightness' | 'contrast', value: string) {
    if (!this.rangeHistoryArmed) { this.pushEditorHistory(); this.rangeHistoryArmed = true; }
    const n = Number(value);
    if (field === 'angle') this.editorAngle = n;
    if (field === 'brightness') this.editorBrightness = n;
    if (field === 'contrast') this.editorContrast = n;
    this.renderEditor();
  }
  onEditorRangeCommit() { this.rangeHistoryArmed = false; }

  private renderEditor() {
    const base = this.editorBase;
    if (!base.width) return;
    const canvas = this.editorCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const rot = this.editorRotate;
    const swap = rot === 90 || rot === 270;
    const bw = base.width, bh = base.height;
    canvas.width = swap ? bh : bw;
    canvas.height = swap ? bw : bh;

    ctx.save();
    ctx.filter = `brightness(${this.editorBrightness}%) contrast(${this.editorContrast}%)${this.editorInvert ? ' invert(1)' : ''}`;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(((rot + this.editorAngle) * Math.PI) / 180);
    ctx.scale(this.editorFlipH ? -1 : 1, this.editorFlipV ? -1 : 1);
    ctx.drawImage(base, -bw / 2, -bh / 2);
    ctx.restore();

    ctx.save();
    ctx.filter = 'none';
    for (const st of this.strokes) this.strokePath(ctx, st);
    if (this.currentStroke) this.strokePath(ctx, this.currentStroke);

    if (this.editorCropMode && this.cropRect) {
      const r = this.cropRect;
      ctx.strokeStyle = '#c8443a'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.fillRect(0, 0, canvas.width, r.y);
      ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - r.y - r.h);
      ctx.fillRect(0, r.y, r.x, r.h);
      ctx.fillRect(r.x + r.w, r.y, canvas.width - r.x - r.w, r.h);
    }

    for (const sh of this.shapes) this.drawShape(ctx, sh);
    if (this.draftShape) this.drawShape(ctx, this.draftShape, true);

    for (const tx of this.texts) {
      ctx.fillStyle = tx.color;
      ctx.font = `bold ${tx.size}px Georgia, serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(tx.text, tx.x, tx.y);
    }
    ctx.restore();
  }

  private drawShape(
    ctx: CanvasRenderingContext2D,
    sh: { kind: 'rect' | 'ellipse' | 'arrow'; x: number; y: number; w: number; h: number; color: string },
    preview = false
  ) {
    ctx.save();
    ctx.strokeStyle = sh.color;
    ctx.lineWidth = 3;
    if (preview) ctx.setLineDash([6, 4]); // dashed while still being dragged, solid once committed
    if (sh.kind === 'rect') {
      ctx.strokeRect(sh.x, sh.y, sh.w, sh.h);
    } else if (sh.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(sh.x + sh.w / 2, sh.y + sh.h / 2, Math.abs(sh.w / 2), Math.abs(sh.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (sh.kind === 'arrow') {
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x + sh.w, sh.y + sh.h); ctx.stroke();
      const angle = Math.atan2(sh.h, sh.w), L = 12;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sh.x + sh.w, sh.y + sh.h);
      ctx.lineTo(sh.x + sh.w - L * Math.cos(angle - 0.4), sh.y + sh.h - L * Math.sin(angle - 0.4));
      ctx.moveTo(sh.x + sh.w, sh.y + sh.h);
      ctx.lineTo(sh.x + sh.w - L * Math.cos(angle + 0.4), sh.y + sh.h - L * Math.sin(angle + 0.4));
      ctx.stroke();
    }
    ctx.restore();
  }

  private strokePath(ctx: CanvasRenderingContext2D, st: { color: string; width: number; points: { x: number; y: number }[] }) {
    ctx.strokeStyle = st.color; ctx.lineWidth = st.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    st.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
  }

  private posFromEvent(ev: MouseEvent | TouchEvent): { x: number; y: number } {
    const canvas = this.editorCanvasRef!.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const point = (ev as TouchEvent).touches ? (ev as TouchEvent).touches[0] : (ev as MouseEvent);
    return { x: (point.clientX - rect.left) * sx, y: (point.clientY - rect.top) * sy };
  }

  onEditorCanvasDown(ev: MouseEvent | TouchEvent) {
    if (this.editorDrawMode) {
      this.pushEditorHistory();
      this.currentStroke = { color: this.editorPenColor, width: this.editorPenWidth, points: [this.posFromEvent(ev)] };
      ev.preventDefault();
    } else if (this.editorCropMode) {
      this.pushEditorHistory();
      const p = this.posFromEvent(ev);
      this.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
      this.cropDragStart = p;
      ev.preventDefault();
    } else if (this.editorShapePlaceMode) {
      this.pushEditorHistory();
      const p = this.posFromEvent(ev);
      this.shapeDragStart = p;
      this.draftShape = { kind: this.editorShapePlaceMode, x: p.x, y: p.y, w: 0, h: 0, color: this.editorPenColor };
      ev.preventDefault();
    } else if (this.editorTextPlaceMode) {
      this.openTextEntryAt(ev);
      ev.preventDefault();
    }
  }
  onEditorCanvasMove(ev: MouseEvent | TouchEvent) {
    if (this.editorDrawMode && this.currentStroke) {
      this.currentStroke.points.push(this.posFromEvent(ev));
      this.renderEditor();
      ev.preventDefault();
    } else if (this.editorCropMode && this.cropDragStart) {
      const p = this.posFromEvent(ev);
      const s = this.cropDragStart;
      this.cropRect = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      this.renderEditor();
      ev.preventDefault();
    } else if (this.editorShapePlaceMode && this.shapeDragStart && this.draftShape) {
      const p = this.posFromEvent(ev);
      const s = this.shapeDragStart;
      // Rect/ellipse: normalize to a top-left+size box so dragging in any direction works.
      // Arrow: keep raw start->end so the arrowhead points the way the user dragged.
      if (this.draftShape.kind === 'arrow') {
        this.draftShape = { ...this.draftShape, x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y };
      } else {
        this.draftShape = { ...this.draftShape, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      }
      this.renderEditor();
      ev.preventDefault();
    }
  }
  onEditorCanvasUp() {
    if (this.editorDrawMode && this.currentStroke) {
      this.strokes.push(this.currentStroke);
      this.currentStroke = null;
      this.renderEditor();
    } else if (this.editorShapePlaceMode && this.draftShape) {
      if (Math.abs(this.draftShape.w) > 3 || Math.abs(this.draftShape.h) > 3) {
        this.shapes.push(this.draftShape);
      }
      this.draftShape = null;
      this.shapeDragStart = null;
      this.editorShapePlaceMode = null; // one shape per click, matching typical pro-tool behavior; click the tool again for another
      this.editorHint = '';
      this.renderEditor();
    }
    this.cropDragStart = null;
  }

  // ── Click-to-place text ──
  private openTextEntryAt(ev: MouseEvent | TouchEvent) {
    const canvas = this.editorCanvasRef!.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const point = (ev as TouchEvent).touches ? (ev as TouchEvent).touches[0] : (ev as MouseEvent);
    const screenX = point.clientX - rect.left;
    const screenY = point.clientY - rect.top;
    const canvasPos = this.posFromEvent(ev);
    this.editorTextEntry = { screenX, screenY, canvasX: canvasPos.x, canvasY: canvasPos.y, value: '' };
  }
  confirmTextEntry() {
    const entry = this.editorTextEntry;
    if (!entry) return;
    const text = entry.value.trim();
    if (text) {
      this.texts.push({ text, x: entry.canvasX, y: entry.canvasY, size: 28, color: this.editorPenColor });
    }
    this.editorTextEntry = null;
    this.editorTextPlaceMode = false;
    this.editorHint = '';
    this.renderEditor();
  }
  cancelTextEntry() {
    this.editorTextEntry = null;
    this.editorTextPlaceMode = false;
    this.editorHint = '';
  }

  private compositeEditorCanvas(): HTMLCanvasElement {
    const canvas = this.editorCanvasRef!.nativeElement;
    if (this.editorCropMode && this.cropRect && this.cropRect.w > 4 && this.cropRect.h > 4) {
      const r = this.cropRect;
      const out = document.createElement('canvas');
      out.width = r.w; out.height = r.h;
      out.getContext('2d')!.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      return out;
    }
    return canvas;
  }

  downloadEditorPng() {
    const out = this.compositeEditorCanvas();
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = 'slide_edited.png';
    a.click();
  }

  saveEditor() {
    if (!this.editorTargetUid) return;
    const tile = this.canvasTiles.find(t => t.uid === this.editorTargetUid);
    if (!tile) return;
    tile.thumb = this.compositeEditorCanvas().toDataURL('image/png');
    tile.rot = 0; // rotation is now baked into the saved image
    this.closeEditor();
  }
}