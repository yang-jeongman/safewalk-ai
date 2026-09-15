// 디버그 로거 - 원격 디버깅 없이 실기기(iOS/Android)에서 상태를 화면에 바로 찍어본다
const STORAGE_KEY = 'debugModeEnabled';
const MAX_LOGS = 200;

class DebugLogger {
    constructor() {
        this.enabled = localStorage.getItem(STORAGE_KEY) === 'true';
        this.panelEl = null;
        this.listEl = null;
    }

    init() {
        this.panelEl = document.getElementById('debugPanel');
        this.listEl = document.getElementById('debugLogList');

        window.addEventListener('error', (e) => {
            this.log(`[JS 에러] ${e.message} (${e.filename}:${e.lineno})`);
        });
        window.addEventListener('unhandledrejection', (e) => {
            this.log(`[Promise 거부] ${e.reason}`);
        });

        if (this.enabled) this.show();

        this.log(`UA: ${navigator.userAgent}`);
        this.log(`speechSynthesis 지원: ${'speechSynthesis' in window}`);
    }

    toggle() {
        this.enabled = !this.enabled;
        localStorage.setItem(STORAGE_KEY, String(this.enabled));
        if (this.enabled) {
            this.show();
        } else {
            this.hide();
        }
    }

    show() {
        this.enabled = true;
        if (this.panelEl) this.panelEl.classList.add('active');
    }

    hide() {
        if (this.panelEl) this.panelEl.classList.remove('active');
    }

    log(msg) {
        const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const line = `${time} ${msg}`;

        console.log(line);

        if (this.listEl) {
            const row = document.createElement('div');
            row.className = 'debug-log-line';
            row.textContent = line;
            this.listEl.appendChild(row);
            while (this.listEl.children.length > MAX_LOGS) {
                this.listEl.removeChild(this.listEl.firstChild);
            }
            this.listEl.scrollTop = this.listEl.scrollHeight;
        }
    }

    clear() {
        if (this.listEl) this.listEl.innerHTML = '';
    }
}

export const debugLogger = new DebugLogger();
