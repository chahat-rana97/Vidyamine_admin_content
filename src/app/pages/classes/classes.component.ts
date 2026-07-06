import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-classes',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './classes.component.html',
  styleUrls: ['./classes.component.css']
})
export class ClassesComponent implements OnInit {
  boards: any[] = [];
  classes: any[] = [];
  filtered: any[] = [];
  loading = false;
  loadingBoards = false;
  search = '';
  selectedBoardId = '';
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
    return this.classes.filter(c => this.isActive(c)).length;
  }

  loadBoards() {
    this.loadingBoards = true;
    this.api.get<any>('/boards').subscribe({
      next: r => {
        this.loadingBoards = false;
        if (r?.status) {
          this.boards = this.readList(r);
          this.selectedBoardId = String(this.boards[0]?.id || '');
          if (this.selectedBoardId) this.load();
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
    this.load();
  }

  load() {
    if (!this.selectedBoardId) {
      this.classes = [];
      this.applyFilter();
      return;
    }

    this.loading = true;
    this.api.get<any>(`/classes?board_id=${encodeURIComponent(this.selectedBoardId)}`).subscribe({
      next: r => {
        if (r?.status) {
          this.classes = this.readList(r);
          this.applyFilter();
        } else {
          this.toast.error(r?.message || 'Failed to load classes');
        }
        this.loading = false;
      },
      error: () => {
        this.toast.error('Failed to load classes');
        this.loading = false;
      }
    });
  }

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.classes.filter(c =>
          this.className(c).toLowerCase().includes(q) ||
          this.boardName(c).toLowerCase().includes(q) ||
          String(c.class_number || '').toLowerCase().includes(q)
        )
      : [...this.classes];
  }

  openAdd() {
    if (!this.selectedBoardId) {
      this.toast.error('Select a board first');
      return;
    }

    const nextNumber = this.nextClassNumber();
    this.modal = {
      open: true,
      mode: 'add',
      data: {
        board_id: Number(this.selectedBoardId),
        name: nextNumber ? `Class ${nextNumber}` : '',
        class_number: nextNumber,
        display_order: this.classes.length + 1,
        is_active: 1
      }
    };
  }

  openEdit(c: any) {
    this.modal = {
      open: true,
      mode: 'edit',
      data: { ...c, board_id: Number(c.board_id || this.selectedBoardId) }
    };
  }

  closeModal() {
    this.modal.open = false;
  }

  save() {
    const d = this.modal.data;
    if (!d.board_id) { this.toast.error('Board is required'); return; }
    if (!d.name?.trim()) { this.toast.error('Class name is required'); return; }
    if (!d.class_number) { this.toast.error('Class number is required'); return; }

    this.saving = true;
    const payload = {
      board_id: Number(d.board_id),
      name: d.name,
      class_number: Number(d.class_number),
      display_order: Number(d.display_order || 0),
      is_active: Number(d.is_active)
    };

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/classes', payload)
      : this.api.put<any>(`/classes/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'Class created' : 'Class updated');
          this.closeModal();
          this.selectedBoardId = String(payload.board_id);
          this.load();
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

  confirmDelete(c: any) {
    this.deleteConfirm = c;
  }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/classes/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) {
          this.toast.success('Class deleted');
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

  className(c: any): string {
    return c.name || c.class_name || (c.class_number ? `Class ${c.class_number}` : '') || '';
  }

  boardName(c: any): string {
    const boardId = String(c.board_id || this.selectedBoardId || '');
    const board = this.boards.find(b => String(b.id) === boardId);
    return c.board_name || c.board?.name || board?.name || board?.code || '';
  }

  isActive(c: any): boolean {
    return c.is_active === true || c.is_active === 1 || c.status === 'active';
  }

  boardLabel(b: any): string {
    return b.code || b.name || `Board ${b.id}`;
  }

  get canWrite() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  private nextClassNumber(): number | null {
    const max = this.classes.reduce((n, c) => Math.max(n, Number(c.class_number || 0)), 0);
    return max ? max + 1 : null;
  }

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.data?.boards)) return r.data.boards;
    if (Array.isArray(r?.data?.classes)) return r.data.classes;
    if (Array.isArray(r?.boards)) return r.boards;
    if (Array.isArray(r?.classes)) return r.classes;
    return [];
  }
}