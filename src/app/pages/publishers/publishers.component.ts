import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-publishers',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './publishers.component.html',
  styleUrls: ['./publishers.component.css']
})
export class PublishersComponent implements OnInit {
  boards: any[] = [];
  publishers: any[] = [];
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
    return this.publishers.filter(p => this.isActive(p)).length;
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
          // Default to "All Boards" so every publisher is visible on first load,
          // instead of silently scoping to whichever board loaded first.
          this.selectedBoardId = '';
          this.load();
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
    this.loading = true;
    // Empty selectedBoardId means "All Boards" — the API returns every publisher
    // across all boards when board_id is omitted.
    const url = this.selectedBoardId
      ? `/publishers?board_id=${encodeURIComponent(this.selectedBoardId)}`
      : '/publishers';

    this.api.get<any>(url).subscribe({
      next: r => {
        if (r?.status) {
          this.publishers = this.readList(r);
          this.applyFilter();
        } else {
          this.toast.error(r?.message || 'Failed to load publishers');
        }
        this.loading = false;
      },
      error: () => {
        this.toast.error('Failed to load publishers');
        this.loading = false;
      }
    });
  }

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.publishers.filter(p =>
          this.publisherName(p).toLowerCase().includes(q) ||
          String(p.code || '').toLowerCase().includes(q) ||
          String(p.short_name || '').toLowerCase().includes(q) ||
          this.boardName(p).toLowerCase().includes(q)
        )
      : [...this.publishers];
  }

  openAdd() {
    if (!this.selectedBoardId) { this.toast.error('Select a board first'); return; }

    this.modal = {
      open: true,
      mode: 'add',
      data: {
        board_id: Number(this.selectedBoardId),
        name: '',
        code: '',
        short_name: '',
        website_url: '',
        description: '',
        display_order: this.publishers.length + 1,
        is_active: 1
      }
    };
  }

  openEdit(p: any) {
    this.modal = {
      open: true,
      mode: 'edit',
      data: { ...p, board_id: Number(p.board_id || this.selectedBoardId) }
    };
  }

  closeModal() {
    this.modal.open = false;
  }

  save() {
    const d = this.modal.data;
    if (!d.board_id) { this.toast.error('Board is required'); return; }
    if (!d.name?.trim()) { this.toast.error('Publisher name is required'); return; }
    if (!d.code?.trim()) { this.toast.error('Publisher code is required'); return; }

    this.saving = true;
    const payload = {
      board_id: Number(d.board_id),
      name: d.name,
      code: d.code,
      short_name: d.short_name || null,
      website_url: d.website_url || null,
      description: d.description || null,
      display_order: Number(d.display_order || 0),
      is_active: Number(d.is_active)
    };

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/publishers', payload)
      : this.api.put<any>(`/publishers/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'Publisher created' : 'Publisher updated');
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

  confirmDelete(p: any) {
    this.deleteConfirm = p;
  }

  doDelete() {
    if (!this.deleteConfirm) return;
    this.api.delete<any>(`/publishers/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) {
          this.toast.success('Publisher deleted');
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

  publisherName(p: any): string {
    return p.name || '';
  }

  boardName(p: any): string {
    if (p.board_name) return p.board_name;
    const boardId = String(p.board_id || '');
    const board = this.boards.find(b => String(b.id) === boardId);
    return board?.name || board?.code || '';
  }

  boardLabel(b: any): string {
    return b.code || b.name || `Board ${b.id}`;
  }

  isActive(p: any): boolean {
    return p.is_active === true || p.is_active === 1 || p.status === 'active';
  }

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.data?.boards)) return r.data.boards;
    if (Array.isArray(r?.data?.publishers)) return r.data.publishers;
    if (Array.isArray(r?.boards)) return r.boards;
    if (Array.isArray(r?.publishers)) return r.publishers;
    return [];
  }
}