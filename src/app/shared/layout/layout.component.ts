import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgClass } from '@angular/common';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { NotificationService, AppNotification } from '../../core/services/notification.service';
import { ToastComponent } from '../components/toast/toast.component';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  roles?: string[];
  /** roles listed here can SEE this item but get an Access Denied dialog on click */
  restrictedRoles?: string[];
  /** optional sub-navigation items rendered as a collapsible group under this item */
  children?: NavItem[];
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
export class LayoutComponent implements OnInit, OnDestroy {
  sidebarOpen = true;
  showLogoutConfirm = false;
  showAccessDenied = false;
  accessDeniedLabel = '';

  // ---- notifications (bell icon + dropdown, global across all screens) ----
  showNotifPanel = false;
  /** the most recent notification, shown as a floating instant popup when it arrives */
  popupNotification: AppNotification | null = null;
  private popupTimeout: any = null;
  private newNotifSub?: Subscription;

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
    },
    {
      groupLabel: 'Reports',
      items: [
        { label: 'Content Report', icon: 'icon-reports', route: '/reports/content', restrictedRoles: ['editor'] },
        { label: 'Assignment Report', icon: 'icon-reports', route: '/reports/assignments', restrictedRoles: ['editor', 'admin'] },
        { label: 'Chapter Report', icon: 'icon-reports', route: '/reports/chapter-coverage' },
      ]
    }
  ];

  /** routes (by label) whose submenu is currently expanded */
  expandedItems = new Set<string>();

  constructor(
    public auth: AuthService,
    public themeSvc: ThemeService,
    public notif: NotificationService,
    private router: Router
  ) {}

  ngOnInit() {
    // auto-expand any parent whose child route is currently active (e.g. deep link / refresh on /reports/content)
    for (const group of this.navGroups) {
      for (const item of group.items) {
        if (this.hasActiveChild(item)) {
          this.expandedItems.add(item.label);
        }
      }
    }

    // Start the shared poll loop (safe even if the dashboard also calls start()
    // — the service only runs one interval regardless of subscriber count).
    this.notif.start();

    // Show a floating instant popup the moment a genuinely new notification arrives.
    this.newNotifSub = this.notif.newNotification$.subscribe(n => {
      this.popupNotification = n;
      if (this.popupTimeout) clearTimeout(this.popupTimeout);
      this.popupTimeout = setTimeout(() => { this.popupNotification = null; }, 6000);
    });
  }

  ngOnDestroy() {
    this.notif.release();
    this.newNotifSub?.unsubscribe();
    if (this.popupTimeout) clearTimeout(this.popupTimeout);
  }

  toggleTheme() { this.themeSvc.toggle(); }

  get visibleNavGroups(): NavGroup[] {
    const role = this.auth.user?.role;
    return this.navGroups
      .map(group => ({
        ...group,
        items: group.items
          .filter(n => !n.roles || !role || n.roles.includes(role))
          .map(n => n.children
            ? { ...n, children: n.children.filter(c => !c.roles || !role || c.roles.includes(role)) }
            : n
          )
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
      event.stopPropagation();
      this.accessDeniedLabel = item.label;
      this.showAccessDenied = true;
      return;
    }
    if (item.children?.length) {
      // parent items with children act as expand/collapse toggles, not direct links
      event.preventDefault();
      this.toggleExpanded(item);
    }
  }

  toggleExpanded(item: NavItem) {
    if (this.expandedItems.has(item.label)) {
      this.expandedItems.delete(item.label);
    } else {
      this.expandedItems.add(item.label);
    }
  }

  isExpanded(item: NavItem): boolean {
    return this.expandedItems.has(item.label);
  }

  hasActiveChild(item: NavItem): boolean {
    if (!item.children?.length) return false;
    const url = this.router.url;
    return item.children.some(c => url.startsWith(c.route));
  }

  closeAccessDenied() { this.showAccessDenied = false; }

  // ---- notifications ----

  toggleNotifPanel(event: Event) {
    event.stopPropagation();
    this.showNotifPanel = !this.showNotifPanel;
  }

  closeNotifPanel() {
    this.showNotifPanel = false;
  }

  /** Clicking anywhere outside the bell/dropdown closes it. */
  @HostListener('document:click')
  onDocumentClick() {
    if (this.showNotifPanel) this.showNotifPanel = false;
  }

  openNotificationTopic(n: AppNotification, event?: Event) {
    event?.stopPropagation();
    this.notif.markRead(n);
    this.showNotifPanel = false;
    this.popupNotification = null;
    if (this.popupTimeout) clearTimeout(this.popupTimeout);
    if (!n.chapter_id) return;
    this.router.navigate(['/topics'], { queryParams: { chapter_id: n.chapter_id } });
  }

  dismissPopup(event?: Event) {
    event?.stopPropagation();
    this.popupNotification = null;
    if (this.popupTimeout) clearTimeout(this.popupTimeout);
  }
}