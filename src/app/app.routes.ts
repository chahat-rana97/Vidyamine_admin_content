import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { LayoutComponent } from './shared/layout/layout.component';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
  // Full-screen Compare view — deliberately outside the LayoutComponent shell
  // (no sidebar/topbar) so the split-pane review UI gets the full viewport,
  // matching the "Detail Review" full-page workbench design.
  {
    path: 'compare',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/compare-view/compare-view.component').then(m => m.CompareViewComponent)
  },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard',   loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'admin-users', loadComponent: () => import('./pages/admin-users/admin-users.component').then(m => m.AdminUsersComponent) },
      { path: 'boards',      loadComponent: () => import('./pages/boards/boards.component').then(m => m.BoardsComponent) },
      { path: 'classes',     loadComponent: () => import('./pages/classes/classes.component').then(m => m.ClassesComponent) },
      { path: 'subjects',    loadComponent: () => import('./pages/subjects/subjects.component').then(m => m.SubjectsComponent) },
      { path: 'publishers',  loadComponent: () => import('./pages/publishers/publishers.component').then(m => m.PublishersComponent) },
      { path: 'languages',   loadComponent: () => import('./pages/languages/languages.component').then(m => m.LanguagesComponent) },
      { path: 'course-types', loadComponent: () => import('./pages/course-types/course-types.component').then(m => m.CourseTypesComponent) },
      { path: 'books',       loadComponent: () => import('./pages/books/books.component').then(m => m.BooksComponent) },
      { path: 'chapters',    loadComponent: () => import('./pages/chapters/chapters.component').then(m => m.ChaptersComponent) },
      { path: 'topics',      loadComponent: () => import('./pages/topics/topics.component').then(m => m.TopicsComponent) },
      { path: 'reports/content', loadComponent: () => import('./pages/reports/reports.component').then(m => m.ReportsComponent) },
      { path: 'reports/chapter-coverage', loadComponent: () => import('./pages/chapter-coverage-report/chapter-coverage-report.component').then(m => m.ChapterCoverageReportComponent) },
      { path: 'reports/chapters/:id', loadComponent: () => import('./pages/chapter-report/chapter-report.component').then(m => m.ChapterReportComponent) },
      { path: 'reports/assignments', loadComponent: () => import('./pages/assignment-report/assignment-report.component').then(m => m.AssignmentReportComponent) },
    ]
  },
  { path: '**', redirectTo: 'dashboard' }
];