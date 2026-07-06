import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, of } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly BASE = 'https://uat.vidyamine.com/dev_chahat/getadminvm';

  constructor(private http: HttpClient) {}

  private headers(isFormData: boolean = false): HttpHeaders {
    const token = localStorage.getItem('vm_token');
    const base: any = {
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    // For FormData (file uploads), do NOT set Content-Type — the browser
    // must generate its own multipart boundary itself, or the server
    // can't parse the parts and getUploadedFiles() comes back empty.
    if (!isFormData) {
      base['Content-Type'] = 'application/json';
    }
    return new HttpHeaders(base);
  }

  // Wraps HTTP errors so error responses (400/401/404/409/500)
  // are returned as normal values instead of thrown exceptions.
  // Components can then check res.status === false normally.
  private handle<T>(obs: Observable<T>): Observable<T> {
    return obs.pipe(
      catchError(err => of(err?.error ?? { status: false, status_code: err?.status, message: err?.message }))
    );
  }

  get<T>(path: string): Observable<T> {
    return this.handle(this.http.get<T>(`${this.BASE}${path}`, { headers: this.headers() }));
  }

  post<T>(path: string, body: any): Observable<T> {
    const isFormData = body instanceof FormData;
    return this.handle(this.http.post<T>(`${this.BASE}${path}`, body, { headers: this.headers(isFormData) }));
  }

  put<T>(path: string, body: any): Observable<T> {
    const isFormData = body instanceof FormData;
    return this.handle(this.http.put<T>(`${this.BASE}${path}`, body, { headers: this.headers(isFormData) }));
  }

  delete<T>(path: string): Observable<T> {
    return this.handle(this.http.delete<T>(`${this.BASE}${path}`, { headers: this.headers() }));
  }
}