import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-course-types',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './course-types.component.html',
  styleUrls: ['./course-types.component.css']
})
export class CourseTypesComponent implements OnInit {
  courseTypes: any[] = [];
  filtered: any[] = [];
  loading = false;
  search = '';

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
    this.load();
  }

  get activeCount() {
    return this.courseTypes.filter(c => this.isActive(c)).length;
  }

  get canWrite() {
    return ['superadmin', 'admin'].includes(this.auth.user?.role || '');
  }

  load() {
    this.loading = true;
    this.api.get<any>('/course-types').subscribe({
      next: r => {
        if (r?.status) {
          this.courseTypes = this.readList(r);
          this.applyFilter();
        } else {
          this.toast.error(r?.message || 'Failed to load course types');
        }
        this.loading = false;
      },
      error: () => {
        this.toast.error('Failed to load course types');
        this.loading = false;
      }
    });
  }

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.courseTypes.filter(c =>
          (c.code || '').toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q)
        )
      : [...this.courseTypes];
  }

  openAdd() {
    this.modal = {
      open: true,
      mode: 'add',
      data: {
        code: '',
        description: '',
        status: 'Active'
      }
    };
  }

  openEdit(c: any) {
    this.modal = {
      open: true,
      mode: 'edit',
      data: { ...c }
    };
  }

  closeModal() {
    this.modal.open = false;
  }

  save() {
    const d = this.modal.data;
    if (!d.code?.trim()) { this.toast.error('Code is required'); return; }

    this.saving = true;
    const payload = {
      code: d.code,
      description: d.description || null,
      status: d.status || 'Active'
    };

    const req = this.modal.mode === 'add'
      ? this.api.post<any>('/course-types', payload)
      : this.api.put<any>(`/course-types/${d.id}`, payload);

    req.subscribe({
      next: r => {
        this.saving = false;
        if (r?.status) {
          this.toast.success(this.modal.mode === 'add' ? 'Course type created' : 'Course type updated');
          this.closeModal();
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
    this.api.delete<any>(`/course-types/${this.deleteConfirm.id}`).subscribe({
      next: r => {
        if (r?.status) {
          this.toast.success('Course type deleted');
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

  isActive(c: any): boolean {
    return c.status === 'Active' || c.status === 'active' || c.is_active === 1 || c.is_active === true;
  }

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.data?.course_types)) return r.data.course_types;
    if (Array.isArray(r?.course_types)) return r.course_types;
    return [];
  }
}
