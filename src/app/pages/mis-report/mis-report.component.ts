import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

type ReportLevel = 'class' | 'subject' | 'book' | 'chapter';

interface Board {
  id: number;
  name: string;
}

interface ClassOption {
  id: number;
  name: string;
  board_id: number;
}

interface SubjectOption {
  id: number;
  name: string;
  class_id: number;
  board_id: number;
}

interface BookOption {
  id: number;
  name: string;
  class_id: number;
  subject_id: number;
}

/** Dropdown option that may represent several underlying rows sharing the same name
 *  (e.g. "Class 6" existing separately under CBSE, ICSE, etc. when "All Boards" is picked).
 *  Selecting it filters/sums across every id in the group. */
interface GroupedOption {
  name: string;
  ids: number[];
}

/** Collapses a flat list of {id, name} into one GroupedOption per distinct name,
 *  merging all ids that share that name. Order of first appearance is preserved. */
function groupByName<T extends { id: number; name: string }>(items: T[]): GroupedOption[] {
  const order: string[] = [];
  const byName = new Map<string, number[]>();
  for (const item of items) {
    if (!byName.has(item.name)) {
      byName.set(item.name, []);
      order.push(item.name);
    }
    byName.get(item.name)!.push(item.id);
  }
  return order.map(name => ({ name, ids: byName.get(name)! }));
}

interface MisRow {
  id: number | string;
  label: string;
  topics: number;
  screenshots: number;
  claude_ppt: number;
  claude_pdf: number;
  gpt_ppt: number;
}

/** Merges rows that share the same label (e.g. "Class 6" appearing once per board
 *  under "All Boards") into a single row per label, summing the numeric columns.
 *  Order of first appearance is preserved. */
function mergeRowsByLabel(rows: MisRow[]): MisRow[] {
  const order: string[] = [];
  const byLabel = new Map<string, MisRow>();
  for (const row of rows) {
    const existing = byLabel.get(row.label);
    if (!existing) {
      byLabel.set(row.label, { ...row });
      order.push(row.label);
    } else {
      existing.topics += row.topics || 0;
      existing.screenshots += row.screenshots || 0;
      existing.claude_ppt += row.claude_ppt || 0;
      existing.claude_pdf += row.claude_pdf || 0;
      existing.gpt_ppt += row.gpt_ppt || 0;
    }
  }
  return order.map(label => byLabel.get(label)!);
}

// Claude PPT / Claude PDF / ChatGPT PPT used to be clickable tabs that only
// controlled which column got a visual highlight. That's removed — Claude PDF
// is now permanently highlighted, no toggle needed.
type HighlightableColumn = 'claude_ppt' | 'claude_pdf' | 'gpt_ppt';
const HIGHLIGHTED_COLUMN: HighlightableColumn = 'claude_pdf';

type HasDataFilter =
  | 'all'
  | 'topics' | 'claude_pdf' | 'claude_ppt' | 'gpt_ppt'
  | 'no_topics' | 'no_claude_pdf' | 'no_claude_ppt' | 'no_gpt_ppt';

/** Nothing fancy — each of Class/Subject/Book/Chapter is just a plain single-select
 *  dropdown, exactly like Board. 'all' means no filter applied at that level. */

@Component({
  selector: 'app-mis-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mis-report.component.html',
  styleUrls: ['./mis-report.component.css']
})
export class MisReportComponent implements OnInit {

  // ---- board (single-select, unchanged) ----
  boards: Board[] = [];
  selectedBoardId: number | 'all' = 'all';

  // ---- Class/Subject/Book/Chapter tabs: pick which row-level the table shows.
  // Each tab also gates which of the filters below are usable — see filterLocks(). ----
  level: ReportLevel = 'class';

  // ---- Board/Class/Subject/Book: separate always-visible dropdowns. Chapter dropdown
  // is removed entirely (there's no Chapter-level filter anymore — Chapter tab is
  // just the deepest row-level view, filtered as far down as Book).
  //
  // Each dropdown's raw options are deduped by name (see groupByName) — this matters
  // when "All Boards" is selected, since e.g. "Class 6" exists once per board and
  // would otherwise show up as five identical entries. Selecting a grouped option
  // filters/sums across every underlying id it represents. ----
  classOptionsRaw: ClassOption[] = [];
  subjectOptionsRaw: SubjectOption[] = [];
  bookOptionsRaw: BookOption[] = [];

  classOptions: GroupedOption[] = [];
  subjectOptions: GroupedOption[] = [];
  bookOptions: GroupedOption[] = [];

  selectedClassIds: number[] | 'all' = 'all';
  selectedSubjectIds: number[] | 'all' = 'all';
  selectedBookIds: number[] | 'all' = 'all';

  // Native <select> needs a single bindable value — these hold the *name* of the
  // selected grouped option (or 'all'). onXChange() resolves the name back to the
  // full id array via the matching GroupedOption before filtering/reloading.
  selectedClassName = 'all';
  selectedSubjectName = 'all';
  selectedBookName = 'all';

  // ---- permanently-highlighted column (was previously the "active tab") ----
  readonly highlightedColumn: HighlightableColumn = HIGHLIGHTED_COLUMN;

  // ---- data filter: All / Has Topics / Has Claude PDF / ... / Has No ... ----
  hasDataFilter: HasDataFilter = 'all';
  hasDataOptions: { value: HasDataFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'topics', label: 'Has Topics' },
    { value: 'claude_pdf', label: 'Has Claude PDF' },
    { value: 'claude_ppt', label: 'Has Claude PPT' },
    { value: 'gpt_ppt', label: 'Has ChatGPT PPT' },
    { value: 'no_topics', label: 'Has No Topics' },
    { value: 'no_claude_pdf', label: 'Has No Claude PDF' },
    { value: 'no_claude_ppt', label: 'Has No Claude PPT' },
    { value: 'no_gpt_ppt', label: 'Has No ChatGPT PPT' },
  ];

  // ---- table data ----
  rows: MisRow[] = [];
  loading = false;

  constructor(private api: ApiService, private toast: ToastService) {}

  ngOnInit(): void {
    this.loadBoards();
    this.loadClassOptions();
    this.loadSubjectOptions();
    this.loadBookOptions();
    this.loadRows();
  }

  // ================= OPTION LOADING (cascades: board -> class -> subject -> book -> chapter) =================

  loadBoards(): void {
    this.api.get<any>('/boards').subscribe({
      next: (res) => { if (res?.status) this.boards = res.data || []; },
      error: () => this.toast.error('Failed to load boards')
    });
  }

  /** Classes under the selected board (or every class if 'all'). */
  loadClassOptions(): void {
    const url = this.selectedBoardId === 'all' ? '/classes' : `/classes?board_id=${this.selectedBoardId}`;
    this.api.get<any>(url).subscribe({
      next: (res) => {
        if (res?.status) {
          this.classOptionsRaw = res.data || [];
          this.classOptions = groupByName(this.classOptionsRaw);
          this.pruneSelection('class');
        }
      },
      error: () => this.toast.error('Failed to load classes')
    });
  }

  /** Subjects under the selected board + selected class(es). */
  loadSubjectOptions(): void {
    const params: string[] = [];
    if (this.selectedBoardId !== 'all') params.push(`board_id=${this.selectedBoardId}`);
    if (this.selectedClassIds !== 'all') params.push(`class_ids=${this.selectedClassIds.join(',')}`);
    this.api.get<any>(`/subjects${params.length ? '?' + params.join('&') : ''}`).subscribe({
      next: (res) => {
        if (res?.status) {
          this.subjectOptionsRaw = res.data || [];
          this.subjectOptions = groupByName(this.subjectOptionsRaw);
          this.pruneSelection('subject');
        }
      },
      error: () => this.toast.error('Failed to load subjects')
    });
  }

  /** Books under the selected board + selected class(es) + selected subject(s). */
  loadBookOptions(): void {
    const params: string[] = [];
    if (this.selectedBoardId !== 'all') params.push(`board_id=${this.selectedBoardId}`);
    if (this.selectedClassIds !== 'all') params.push(`class_ids=${this.selectedClassIds.join(',')}`);
    if (this.selectedSubjectIds !== 'all') params.push(`subject_ids=${this.selectedSubjectIds.join(',')}`);
    this.api.get<any>(`/books${params.length ? '?' + params.join('&') : ''}`).subscribe({
      next: (res) => {
        if (res?.status) {
          this.bookOptionsRaw = res.data || [];
          this.bookOptions = groupByName(this.bookOptionsRaw);
          this.pruneSelection('book');
        }
      },
      error: () => this.toast.error('Failed to load books')
    });
  }

  /** Drops the current selection at a level if its name is no longer among the
   *  available grouped options (e.g. after a board/class change removes that name entirely). */
  private pruneSelection(level: 'class' | 'subject' | 'book'): void {
    if (level === 'class') {
      if (this.selectedClassName !== 'all' && !this.classOptions.some(o => o.name === this.selectedClassName)) {
        this.selectedClassName = 'all';
        this.selectedClassIds = 'all';
      }
    } else if (level === 'subject') {
      if (this.selectedSubjectName !== 'all' && !this.subjectOptions.some(o => o.name === this.selectedSubjectName)) {
        this.selectedSubjectName = 'all';
        this.selectedSubjectIds = 'all';
      }
    } else {
      if (this.selectedBookName !== 'all' && !this.bookOptions.some(o => o.name === this.selectedBookName)) {
        this.selectedBookName = 'all';
        this.selectedBookIds = 'all';
      }
    }
  }

  // ================= EVENT HANDLERS =================

  onBoardChange(): void {
    // Board changed — ids from the old board are meaningless under the new one,
    // so reset all three filters back to "All" rather than trying to prune/match them.
    this.selectedClassName = 'all';
    this.selectedClassIds = 'all';
    this.selectedSubjectName = 'all';
    this.selectedSubjectIds = 'all';
    this.selectedBookName = 'all';
    this.selectedBookIds = 'all';
    this.loadClassOptions();
    this.loadSubjectOptions();
    this.loadBookOptions();
    this.loadRows();
  }

  /** Switches which row-level the table shows. Also gates which filters below are
   *  enabled — see isClassFilterLocked() / isSubjectFilterLocked() / isBookFilterLocked(). */
  setLevel(l: ReportLevel): void {
    if (this.level === l) return;
    this.level = l;
    this.loadRows();
  }

  onHasDataFilterChange(): void {
    this.loadRows();
  }

  /** Picking a Class immediately narrows Subject/Book and reloads the table.
   *  Resolves the picked name to its full underlying id array (may be several ids
   *  when the same class name spans multiple boards under "All Boards"). */
  onClassChange(): void {
    const match = this.classOptions.find(o => o.name === this.selectedClassName);
    this.selectedClassIds = match ? match.ids : 'all';
    this.loadSubjectOptions();
    this.loadBookOptions();
    this.loadRows();
  }

  /** Picking a Subject immediately narrows Book and reloads the table. */
  onSubjectChange(): void {
    const match = this.subjectOptions.find(o => o.name === this.selectedSubjectName);
    this.selectedSubjectIds = match ? match.ids : 'all';
    this.loadBookOptions();
    this.loadRows();
  }

  /** Book is the deepest filter now (Chapter dropdown removed) — just reload the table. */
  onBookChange(): void {
    const match = this.bookOptions.find(o => o.name === this.selectedBookName);
    this.selectedBookIds = match ? match.ids : 'all';
    this.loadRows();
  }

  // ================= FILTER LOCKING =================
  // Class tab: only Board usable. Subject tab: Board + Class. Book tab: Board + Class + Subject.
  // Chapter tab: Board + Class + Subject + Book (the max — there's no deeper filter to add).

  isClassFilterLocked(): boolean {
    return this.level === 'class';
  }

  isSubjectFilterLocked(): boolean {
    return this.level === 'class' || this.level === 'subject';
  }

  isBookFilterLocked(): boolean {
    return this.level === 'class' || this.level === 'subject' || this.level === 'book';
  }

  /** Tooltip text shown on a locked filter, telling the person which tab to pick first. */
  lockedFilterMessage(): string {
    const labels: Record<ReportLevel, string> = {
      class: 'Class', subject: 'Subject', book: 'Book', chapter: 'Chapter'
    };
    return `Select ${labels[this.level]} first`;
  }

  // ================= DATA LOAD =================

  loadRows(): void {
    this.loading = true;

    const params: string[] = [`mode=${this.level}`];
    if (this.selectedBoardId !== 'all') {
      params.push(`board_id=${this.selectedBoardId}`);
    }
    if (this.hasDataFilter !== 'all') {
      params.push(`has_data=${this.hasDataFilter}`);
    }

    // Class/Subject/Book filters apply regardless of "view as" level — e.g. you can view
    // as Chapter while filtering to Class 6 and Subject Math.
    if (this.selectedClassIds !== 'all') {
      params.push(`class_ids=${this.selectedClassIds.join(',')}`);
    }
    if (this.selectedSubjectIds !== 'all') {
      params.push(`subject_ids=${this.selectedSubjectIds.join(',')}`);
    }
    if (this.selectedBookIds !== 'all') {
      params.push(`book_ids=${this.selectedBookIds.join(',')}`);
    }

    this.api.get<any>(`/reports/mis?${params.join('&')}`).subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.status) {
          this.rows = mergeRowsByLabel(res.data?.rows || []);
        } else {
          this.toast.error(res?.message || 'Failed to load MIS report');
        }
      },
      error: () => {
        this.loading = false;
        this.toast.error('Failed to load MIS report');
      }
    });
  }

  get columnLabel(): string {
    switch (this.level) {
      case 'class': return 'Class';
      case 'subject': return 'Subject';
      case 'book': return 'Book';
      case 'chapter': return 'Chapter';
    }
  }

  get columnLabelPlural(): string {
    const plurals: Record<ReportLevel, string> = {
      class: 'classes', subject: 'subjects', book: 'books', chapter: 'chapters'
    };
    return this.rows.length === 1 ? this.columnLabel.toLowerCase() : plurals[this.level];
  }

  get totalTopics(): number {
    return this.rows.reduce((sum, r) => sum + (r.topics || 0), 0);
  }

  get totalScreenshots(): number {
    return this.rows.reduce((sum, r) => sum + (r.screenshots || 0), 0);
  }

  get totalClaudePpt(): number {
    return this.rows.reduce((sum, r) => sum + (r.claude_ppt || 0), 0);
  }

  get totalClaudePdf(): number {
    return this.rows.reduce((sum, r) => sum + (r.claude_pdf || 0), 0);
  }

  get totalGptPpt(): number {
    return this.rows.reduce((sum, r) => sum + (r.gpt_ppt || 0), 0);
  }
}