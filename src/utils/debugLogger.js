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

    // 화면에 보이는 로그(최대 MAX_LOGS줄)를 텍스트 Blob으로 만들어 반환한다
    // (다운로드는 직접 트리거하지 않음). 실기기에서 재현된 문제를 스크린샷 대신
    // 텍스트로 그대로 전달할 방법이 없다는 피드백(2026-09-19) 대응.
    // 호출 쪽이 uiController.presentDownload()로 실제 저장 링크를 보여준다 —
    // iOS Safari에서 비동기 처리 이후의 자동 다운로드가 막히는 문제 대응
    // (zipWriter.js 상단 설명 참고. 이 함수 자체는 동기라 원래도 괜찮았을 수 있지만,
    // 내보내기 경로를 전부 같은 방식으로 통일해 플랫폼별로 다르게 동작하지 않게 한다).
    exportAsText() {
        if (!this.listEl || this.listEl.children.length === 0) {
            return { count: 0 };
        }
        const lines = Array.from(this.listEl.children).map(el => el.textContent);
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        return { count: lines.length, blob, filename: `safewalk-debug-log-${Date.now()}.txt` };
    }
}

export const debugLogger = new DebugLogger();
