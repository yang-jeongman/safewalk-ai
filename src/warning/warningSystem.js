// 경고 시스템 모듈
import { debugLogger } from '../utils/debugLogger.js';

export class WarningSystem {
    constructor() {
        this.voiceEnabled = true;
        this.vibrationEnabled = true;
        this.visualEnabled = true;
        this.lastWarningTime = 0;
        this.warningCooldown = 2000; // 2초 쿨다운

        // 음성 합성 초기화
        this.synth = window.speechSynthesis;
        this.voice = null;

        // 설정 로드
        this.loadSettings();
        this.initVoice();
    }

    initVoice() {
        // 한국어 음성 찾기
        const voices = this.synth.getVoices();
        this.voice = voices.find(v => v.lang.includes('ko')) || voices[0];
        debugLogger.log(`[음성] 초기 voices=${voices.length}개, 선택=${this.voice ? `${this.voice.name}/${this.voice.lang}` : '없음'}`);

        // 음성 로드 이벤트
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = () => {
                const voices = this.synth.getVoices();
                this.voice = voices.find(v => v.lang.includes('ko')) || voices[0];
                debugLogger.log(`[음성] onvoiceschanged voices=${voices.length}개, 선택=${this.voice ? `${this.voice.name}/${this.voice.lang}` : '없음'}`);
            };
        }
    }

    loadSettings() {
        // 로컬 스토리지에서 설정 로드
        const settings = localStorage.getItem('warningSettings');
        if (settings) {
            const parsed = JSON.parse(settings);
            this.voiceEnabled = parsed.voice !== false;
            this.vibrationEnabled = parsed.vibration !== false;
            this.visualEnabled = parsed.visual !== false;
        }
    }

    saveSettings() {
        localStorage.setItem('warningSettings', JSON.stringify({
            voice: this.voiceEnabled,
            vibration: this.vibrationEnabled,
            visual: this.visualEnabled
        }));
    }

    // 위험 경고 (높은 위험도)
    alert(threat) {
        if (!this.shouldWarn()) return;

        const message = this.generateMessage(threat, 'danger');

        // 음성 경고
        if (this.voiceEnabled) {
            this.speak(message, 1.2, 1); // 빠른 속도, 높은 음조
        }

        // 진동 경고 (강한 패턴)
        if (this.vibrationEnabled && navigator.vibrate) {
            navigator.vibrate([200, 100, 200, 100, 200]);
        }

        // 시각 경고
        if (this.visualEnabled) {
            this.showVisualAlert(message, 'danger');
        }

        this.lastWarningTime = Date.now();
    }

    // 주의 경고 (중간 위험도)
    warn(threat) {
        if (!this.shouldWarn(3000)) return; // 3초 쿨다운

        const message = this.generateMessage(threat, 'warning');

        // 음성 경고
        if (this.voiceEnabled) {
            this.speak(message, 1, 0.9);
        }

        // 진동 경고 (중간 패턴)
        if (this.vibrationEnabled && navigator.vibrate) {
            navigator.vibrate([150, 150, 150]);
        }

        // 시각 경고
        if (this.visualEnabled) {
            this.showVisualAlert(message, 'warning');
        }

        this.lastWarningTime = Date.now();
    }

    // 정보 알림 (낮은 위험도)
    info(message) {
        // 음성 안내
        if (this.voiceEnabled) {
            this.speak(message, 0.9, 0.8); // 느린 속도, 낮은 음조
        }

        // 약한 진동
        if (this.vibrationEnabled && navigator.vibrate) {
            navigator.vibrate(100);
        }

        // 시각 알림
        if (this.visualEnabled) {
            this.showVisualAlert(message, 'info');
        }
    }

    generateMessage(threat, level) {
        const { class: objClass, distance, direction } = threat;

        // 객체명 한글 변환
        const objectNames = {
            'car': '자동차',
            'bus': '버스',
            'truck': '트럭',
            'motorcycle': '오토바이',
            'bicycle': '자전거',
            'person': '사람',
            'traffic light': '신호등',
            'stop sign': '정지 표지판'
        };

        const objName = objectNames[objClass] || objClass;
        const distanceStr = distance < 3 ? '가까운' : `${Math.round(distance)}미터`;

        // 위험도에 따른 메시지
        switch (level) {
            case 'danger':
                return `위험! ${direction} ${objName}`;

            case 'warning':
                return `주의, ${distanceStr} ${objName}`;

            default:
                return `${objName} 감지됨`;
        }
    }

    // iOS Safari는 사용자 제스처와 동기적으로 연결되지 않은 speak() 호출을
    // 조용히 무시한다. 버튼 클릭 핸들러 안에서 먼저 호출해 음성 합성을 깨워둔다.
    unlock() {
        const utterance = new SpeechSynthesisUtterance(' ');
        utterance.volume = 0;
        this._unlockUtterance = utterance;

        utterance.onstart = () => debugLogger.log('[unlock] onstart');
        utterance.onend = () => debugLogger.log('[unlock] onend');
        utterance.onerror = (e) => debugLogger.log(`[unlock] onerror: ${e.error}`);

        debugLogger.log(`[unlock] speak() 호출, speaking=${this.synth.speaking} pending=${this.synth.pending} paused=${this.synth.paused}`);
        this.synth.speak(utterance);
    }

    speak(text, rate = 1, pitch = 1) {
        debugLogger.log(`[speak] 요청: "${text}" speaking=${this.synth.speaking} pending=${this.synth.pending} paused=${this.synth.paused}`);

        // 이전 음성 중지
        if (this.synth.speaking || this.synth.pending) {
            this.synth.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = this.voice;
        utterance.rate = rate;
        utterance.pitch = pitch;
        utterance.volume = 1;

        utterance.onstart = () => debugLogger.log(`[speak] onstart: "${text}"`);
        utterance.onend = () => debugLogger.log(`[speak] onend: "${text}"`);
        utterance.onerror = (e) => debugLogger.log(`[speak] onerror: ${e.error} ("${text}")`);

        // iOS Safari는 지역 변수만 참조된 SpeechSynthesisUtterance를
        // 재생 전에 GC로 수거해버리는 버그가 있다(에러 없이 조용히 무음).
        // 인스턴스에 참조를 유지해 GC 대상에서 제외한다.
        this._utterance = utterance;
        this.synth.speak(utterance);
        debugLogger.log(`[speak] speak() 호출 직후 speaking=${this.synth.speaking} pending=${this.synth.pending}`);
    }

    showVisualAlert(message, type) {
        const alertZone = document.getElementById('alertZone');
        if (!alertZone) return;

        // 알림 요소 생성
        const alert = document.createElement('div');
        alert.className = `alert ${type}`;
        alert.textContent = message;

        // 기존 알림 제거
        alertZone.innerHTML = '';
        alertZone.appendChild(alert);
        alertZone.classList.add('active');

        // 자동 제거
        setTimeout(() => {
            alert.remove();
            if (alertZone.children.length === 0) {
                alertZone.classList.remove('active');
            }
        }, 3000);

        // 화면 테두리 효과
        this.flashScreen(type);
    }

    flashScreen(type) {
        const colors = {
            danger: 'rgba(244, 67, 54, 0.5)',
            warning: 'rgba(255, 152, 0, 0.5)',
            info: 'rgba(33, 150, 243, 0.5)'
        };

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: ${colors[type] || colors.info};
            pointer-events: none;
            z-index: 9999;
            animation: flash 0.5s ease;
        `;

        // 애니메이션 스타일 추가
        if (!document.getElementById('flashStyle')) {
            const style = document.createElement('style');
            style.id = 'flashStyle';
            style.textContent = `
                @keyframes flash {
                    0% { opacity: 0; }
                    50% { opacity: 1; }
                    100% { opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(overlay);
        setTimeout(() => overlay.remove(), 500);
    }

    shouldWarn(cooldown = this.warningCooldown) {
        const now = Date.now();
        return (now - this.lastWarningTime) > cooldown;
    }

    // 설정 변경 메서드
    setVoiceEnabled(enabled) {
        this.voiceEnabled = enabled;
        this.saveSettings();
    }

    setVibrationEnabled(enabled) {
        this.vibrationEnabled = enabled;
        this.saveSettings();
    }

    setVisualEnabled(enabled) {
        this.visualEnabled = enabled;
        this.saveSettings();
    }

    // 테스트용 메서드
    test() {
        console.log('경고 시스템 테스트');

        // 테스트 위협 객체
        const testThreat = {
            class: 'car',
            distance: 5,
            direction: '전방',
            level: 0.8
        };

        setTimeout(() => this.info('테스트 시작'), 1000);
        setTimeout(() => this.warn(testThreat), 3000);
        setTimeout(() => this.alert(testThreat), 5000);
    }
}