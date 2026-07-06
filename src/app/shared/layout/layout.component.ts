import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgClass } from '@angular/common';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastComponent } from '../components/toast/toast.component';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  roles?: string[];
  /** roles listed here can SEE this item but get an Access Denied dialog on click */
  restrictedRoles?: string[];
}

interface NavGroup {
  groupLabel: string;
  items: NavItem[];
}

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [NgClass, RouterOutlet, RouterLink, RouterLinkActive, ToastComponent],
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.css']
})
export class LayoutComponent {
  sidebarOpen = true;
  showLogoutConfirm = false;
  showAccessDenied = false;

  navGroups: NavGroup[] = [
    {
      groupLabel: 'Overview',
      items: [
        { label: 'Dashboard',   icon: 'icon-dashboard', route: '/dashboard' },
        { label: 'Admin Users', icon: 'icon-users',     route: '/admin-users', roles: ['superadmin', 'admin', 'editor'], restrictedRoles: ['editor'] },
      ]
    },
    {
      groupLabel: 'Master Data',
      items: [
        { label: 'Manage Boards',      icon: 'icon-boards',      route: '/boards' },
        { label: 'Manage Classes',     icon: 'icon-classes',     route: '/classes' },
        { label: 'Manage Subjects',    icon: 'icon-subjects',    route: '/subjects' },
        { label: 'Manage Publisher',   icon: 'icon-publisher',   route: '/publishers' },
        { label: 'Manage Languages',   icon: 'icon-languages',   route: '/languages' },
        { label: 'Manage Course Type', icon: 'icon-course-type', route: '/course-types' },
      ]
    },
    {
      groupLabel: 'Content',
      items: [
        { label: 'Manage Books',    icon: 'icon-books',    route: '/books' },
        { label: 'Manage Chapters', icon: 'icon-chapters', route: '/chapters' },
      ]
    }
  ];

  constructor(public auth: AuthService, public themeSvc: ThemeService) {}

  toggleTheme() { this.themeSvc.toggle(); }

  get visibleNavGroups(): NavGroup[] {
    const role = this.auth.user?.role;
    return this.navGroups
      .map(group => ({
        ...group,
        items: group.items.filter(n => !n.roles || !role || n.roles.includes(role))
      }))
      .filter(group => group.items.length > 0);
  }

  get userInitials(): string {
    const name = this.auth.user?.name || '';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return (parts[0]?.[0] || 'A').toUpperCase();
  }

  toggleSidebar() { this.sidebarOpen = !this.sidebarOpen; }
  openLogoutConfirm() { this.showLogoutConfirm = true; }
  cancelLogout() { this.showLogoutConfirm = false; }
  confirmLogout() { this.showLogoutConfirm = false; this.auth.logout(); }

  /** returns true if the current user's role is blocked from opening this item */
  isRestricted(item: NavItem): boolean {
    const role = this.auth.user?.role;
    return !!role && !!item.restrictedRoles?.includes(role);
  }

  onNavItemClick(item: NavItem, event: Event) {
    if (this.isRestricted(item)) {
      event.preventDefault();
      this.showAccessDenied = true;
    }
  }

  closeAccessDenied() { this.showAccessDenied = false; }
}