import { Injectable, signal } from '@angular/core';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'vm-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** Reactive signal so components can react to theme changes if needed. */
  theme = signal<Theme>(this.getInitialTheme());

  constructor() {
    this.applyTheme(this.theme());
  }

  private getInitialTheme(): Theme {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved === 'dark' || saved === 'light') return saved;

    // fall back to OS preference if the user never chose explicitly
    const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }

  toggle() {
    this.setTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  setTheme(theme: Theme) {
    this.theme.set(theme);
    localStorage.setItem(STORAGE_KEY, theme);
    this.applyTheme(theme);
  }

  private applyTheme(theme: Theme) {
    // data-theme attribute on <html> drives every CSS variable override
    document.documentElement.setAttribute('data-theme', theme);
  }

  get isLight(): boolean {
    return this.theme() === 'light';
  }
}