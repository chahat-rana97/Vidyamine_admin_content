import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-subjects',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './subjects.component.html',
  styleUrls: ['./subjects.component.css']
})
export class SubjectsComponent implements OnInit {
  boards: any[] = [];
  classes: any[] = [];
  subjects: any[] = [];
  filtered: any[] = [];
  loading = false;
  loadingBoards = false;
  loadingClasses = false;
  search = '';
  selectedBoardId = '';
  selectedClassId = '';

  modal: { open: boolean; mode: 'add' | 'edit'; data: any } = {
    open: false, mode: 'add', data: {}
  };
  saving = false;
  deleteConfirm: any = null;

  constructor(
    private api: ApiService,
    private toast: ToastService,
    public auth: AuthService
  ) {}

  ngOnInit() {
    this.loadBoards();
  }

  get activeCount() {
    return this.subjects.filter(s => this.isActive(s)).length;
  }

  get canWrite() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  loadBoards() {
    this.loadingBoards = true;
    this.api.get<any>('/boards').subscribe({
      next: r => {
        this.loadingBoards = false;
        if (r?.status) {
          this.boards = this.readList(r);
          this.selectedBoardId = String(this.boards[0]?.id || '');
          if (this.selectedBoardId) this.loadClasses();
        } else {
          this.toast.error(r?.message || 'Failed to load boards');
        }
      },
      error: () => {
        this.loadingBoards = false;
        this.toast.error('Failed to load boards');
      }
    });
  }

  onBoardChange() {
    this.search = '';
    this.selectedClassId = '';
    this.subjects = [];
    this.applyFilter();
    this.loadClasses();
  }

  loadClasses() {
    if (!this.selectedBoardId) {
      this.classes = [];
      this.selectedClassId = '';
      this.subjects = [];
      this.applyFilter();
      return;
    }

    this.loadingClasses = true;
    this.api.get<any>(`/classes?board_id=${encodeURIComponent(this.selectedBoardId)}`).subscribe({
      next: r => {
        this.loadingClasses = false;
        if (r?.status) {
          this.classes = this.readList(r);
          this.selectedClassId = String(this.classes[0]?.id || '');
          if (this.selectedClassId) this.load();
          else {
            this.subjects = [];
            this.applyFilter();
          }
        } else {
          this.toast.error(r?.message || 'Failed to load classes');
        }
      },
      error: () => {
        this.loadingClasses = false;
        this.toast.error('Failed to load classes');
      }
    });
  }

  onClassChange() {
    this.search = '';
    this.load();
  }

  load() {
    if (!this.selectedClassId) {
      this.subjects = [];
      this.applyFilter();
      return;
    }

    this.loading = true;
    this.api.get<any>(`/subjects?class_id=${encodeURIComponent(this.selectedClassId)}`).subscribe({
      next: r => {
        if (r?.status) {
          this.subjects = this.readList(r);
          this.applyFilter();
        } else {
          this.toast.error(r?.message || 'Failed to load subjects');
        }
        this.loading = false;
      },
      error: () => {
        this.toast.error('Failed to load subjects');
        this.loading = false;
      }
    });
  }

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.subjects.filter(s =>
          this.subjectName(s).toLowerCase().includes(q) ||
          this.className(s).toLowerCase().includes(q) ||
          this.boardName(s).toLowerCase().includes(q) ||
          String(s.code || '').toLowerCase().includes(q)
        )
      : [...this.subjects];
  }

  openAdd() {
    if (!this.selectedBoardId) { this.toast.error('Select a board first'); return; }
    if (!this.selectedClassId) { this.toast.error('Select a class first'); return; }

    this.modal = {
      open: true,
      mode: 'add',
      data: {
        board_id: Number(this.selectedBoardId),
        class_id: Number(this.selectedClassId),
        name: '',
        code: '',
        icon_url: '',
        color_hex: '',
        image_url: '',
        tags: '',
        display_order: this.subjects.length + 1,
        is_active: 1
      }
    };
  }

  openEdit(s: any) {
    this.modal = {
      open: true,
      mode: 'edit',
      data: {
        ...s,
        board_id: Number(s.board_id || this.selectedBoardId),
        class_id: Number(s.class_id || this.selectedClassId)
      }
    };
  }

  closeModal() {
    this.modal.open = false;
  }

  onModalBoardChange() {
    const boardId = String(this.modal.data.board_id || '');
    this.modal.data.class_id = null;
    if (!boardId) return;

    this.api.get<any>(`/classes?board_id=${encodeURIComponent(boardId)}`).subscribe({
      next: r => {
        if (r?.status) {
          this.classes = this.readList(r);
          this.modal.data.class_id = this.classes[0]?.id || null;
        } else {
          this.toast.error(r?.message || 'Failed to load classes');
        }
      },
      error: () => this.toast.error('Failed to load classes')
    });
  }

  save() {
    const d = this.modal.data;
    if (!d.board_id) { this.toast.error('Board is required'); return; }
    if (!d.class_id) { this.toast.error('Class is required'); return; }
    if (!d.name?.trim()) { this.toast.error('Subject name is required'); return; }

    this.saving = true;
    const payload = {
      board_id: Number(d.board_id),
      class_id: Number(d.class_id),
      name: d.name,
      code: d.code || null,
      icon_url: d.icon_url || null,
      color_hex: d.color_hex || null,
      image_url: d.image_url || null,
      tags: d.tags || null,
      display_order: Number(d.display_order || 0),
      is_active: Number(d.is_active)
    };

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/subjects', payload)
      : this.api.put<any>(`/subjects/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'Subject created' : 'Subject updated');
          this.closeModal();
          this.selectedBoardId = String(payload.board_id);
          this.selectedClassId = String(payload.class_id);
          this.loadClassesForSelectedSubject();
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

  confirmDelete(s: any) {
    this.deleteConfirm = s;
  }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/subjects/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) {
          this.toast.success('Subject deleted');
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

  subjectName(s: any): string {
    return s.name || '';
  }

  className(s: any): string {
    return this.classLabelById(s.class_id || this.selectedClassId);
  }

  classOptionLabel(c: any): string {
    return c.name || (c.class_number ? `Class ${c.class_number}` : `Class ${c.id}`);
  }

  classLabelById(id: any): string {
    const cls = this.classes.find(c => String(c.id) === String(id || ''));
    if (!cls) return '';
    return cls.name || (cls.class_number ? `Class ${cls.class_number}` : `Class ${cls.id}`);
  }

  boardName(s: any): string {
    const boardId = String(s.board_id || this.selectedBoardId || '');
    const board = this.boards.find(b => String(b.id) === boardId);
    return board?.name || board?.code || '';
  }

  boardLabel(b: any): string {
    return b.code || b.name || `Board ${b.id}`;
  }

  isActive(s: any): boolean {
    return s.is_active === true || s.is_active === 1 || s.status === 'active';
  }

  private loadClassesForSelectedSubject() {
    this.loadingClasses = true;
    this.api.get<any>(`/classes?board_id=${encodeURIComponent(this.selectedBoardId)}`).subscribe({
      next: r => {
        this.loadingClasses = false;
        if (r?.status) {
          this.classes = this.readList(r);
          this.load();
        } else {
          this.toast.error(r?.message || 'Failed to load classes');
        }
      },
      error: () => {
        this.loadingClasses = false;
        this.toast.error('Failed to load classes');
      }
    });
  }

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.data?.boards)) return r.data.boards;
    if (Array.isArray(r?.data?.classes)) return r.data.classes;
    if (Array.isArray(r?.data?.subjects)) return r.data.subjects;
    if (Array.isArray(r?.boards)) return r.boards;
    if (Array.isArray(r?.classes)) return r.classes;
    if (Array.isArray(r?.subjects)) return r.subjects;
    return [];
  }
}