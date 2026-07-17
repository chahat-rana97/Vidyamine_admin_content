import { Injectable, NgZone } from '@angular/core';

declare var webkitSpeechRecognition: any;

/**
 * Thin wrapper around the browser's native Web Speech API
 * (webkitSpeechRecognition — Chrome/Edge only, no external package needed).
 * Used for mic-to-text dictation in comment boxes.
 */
@Injectable({ providedIn: 'root' })
export class SpeechToTextService {
  private recognition: any;
  public isListening = false;

  constructor(private zone: NgZone) {
    if ('webkitSpeechRecognition' in window) {
      this.recognition = new webkitSpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';
    }
  }

  isSupported(): boolean {
    return !!this.recognition;
  }

  /**
   * Starts listening. onResult is called repeatedly with the running
   * transcript text and whether that chunk is final or still interim.
   */
  start(onResult: (text: string, isFinal: boolean) => void, onEnd?: () => void) {
    if (!this.recognition || this.isListening) return;

    this.recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      this.zone.run(() => {
        if (final) onResult(final, true);
        if (interim) onResult(interim, false);
      });
    };

    this.recognition.onend = () => {
      this.zone.run(() => {
        this.isListening = false;
        if (onEnd) onEnd();
      });
    };

    this.recognition.onerror = (e: any) => {
      console.error('Speech recognition error:', e.error);
      this.zone.run(() => {
        this.isListening = false;
        if (onEnd) onEnd();
      });
    };

    this.recognition.start();
    this.isListening = true;
  }

  stop() {
    if (this.recognition && this.isListening) {
      this.recognition.stop();
    }
  }
}