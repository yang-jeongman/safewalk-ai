// SafeWalk AI - 메인 애플리케이션
import { DetectionManager } from '../detection/detectionManager.js';
import { WarningSystem } from '../warning/warningSystem.js';
import { UIController } from '../ui/uiController.js';
import { DataManager } from '../utils/dataManager.js';

class SafeWalkApp {
    constructor() {
        this.isWalking = false;
        this.detectionManager = null;
        this.warningSystem = new WarningSystem();
        this.uiController = new UIController();
        this.dataManager = new DataManager();

        this.walkStartTime = null;
        this.dangerCount = 0;
        this.walkTimer = null;
    }

    async init() {
        console.log('SafeWalk AI 초기화 중...');

        // Service Worker 등록
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('./sw.js');
                console.log('Service Worker 등록 완료');
            } catch (err) {
                console.error('Service Worker 등록 실패:', err);
            }
        }

        // UI 초기화
        this.uiController.init();
        this.bindEvents();

        // 저장된 데이터 로드
        await this.dataManager.init();
        this.updateStats();

        // 스플래시 화면 제거
        setTimeout(() => {
            document.getElementById('splash').classList.remove('active');
            document.getElementById('main').classList.add('active');
        }, 2000);
    }

    bindEvents() {
        // 시작/정지 버튼
        document.getElementById('btnStart').addEventListener('click', () => this.startWalking());
        document.getElementById('btnStop').addEventListener('click', () => this.stopWalking());

        // 긴급 버튼
        document.getElementById('btnEmergency').addEventListener('click', () => this.handleEmergency());

        // 네비게이션
        document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const screen = e.currentTarget.dataset.screen;
                this.uiController.switchScreen(screen);
            });
        });

        // 설정 버튼
        document.getElementById('btnSettings').addEventListener('click', () => {
            this.uiController.switchScreen('settings');
        });

        // 뒤로 가기 버튼
        document.querySelectorAll('.btn-back').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget.dataset.back;
                this.uiController.switchScreen(target);
            });
        });
    }

    async startWalking() {
        if (this.isWalking) return;

        console.log('보행 모드 시작');
        this.isWalking = true;
        this.walkStartTime = Date.now();
        this.dangerCount = 0;

        // UI 전환
        this.uiController.switchScreen('walking');
        this.uiController.updateStatus('walking', { status: 'active' });

        // 카메라 및 탐지 시작
        try {
            this.detectionManager = new DetectionManager();
            await this.detectionManager.init();

            // 탐지 콜백 설정
            this.detectionManager.onDetection = (threats) => this.handleDetection(threats);

            // 탐지 시작
            await this.detectionManager.start();

            // 타이머 시작
            this.startWalkTimer();

        } catch (error) {
            console.error('카메라 시작 실패:', error);
            this.uiController.showAlert('카메라 접근 권한이 필요합니다', 'error');
            this.stopWalking();
        }
    }

    stopWalking() {
        if (!this.isWalking) return;

        console.log('보행 모드 종료');
        this.isWalking = false;

        // 탐지 중지
        if (this.detectionManager) {
            this.detectionManager.stop();
            this.detectionManager = null;
        }

        // 타이머 중지
        if (this.walkTimer) {
            clearInterval(this.walkTimer);
            this.walkTimer = null;
        }

        // 데이터 저장
        const walkDuration = Date.now() - this.walkStartTime;
        this.dataManager.saveWalkSession({
            duration: walkDuration,
            dangerCount: this.dangerCount,
            timestamp: this.walkStartTime
        });

        // UI 전환
        this.uiController.switchScreen('main');
        this.updateStats();
    }

    handleDetection(threats) {
        if (!threats || threats.length === 0) return;

        // 가장 위험한 객체 선택
        const mostDangerous = threats.reduce((max, threat) =>
            threat.level > max.level ? threat : max
        );

        // 위험도에 따른 경고
        if (mostDangerous.level > 0.7) {
            this.dangerCount++;
            this.warningSystem.alert(mostDangerous);
            this.uiController.showDanger(mostDangerous);
        } else if (mostDangerous.level > 0.4) {
            this.warningSystem.warn(mostDangerous);
            this.uiController.showWarning(mostDangerous);
        }

        // 위험도 UI 업데이트
        this.uiController.updateDangerLevel(mostDangerous.level);
    }

    startWalkTimer() {
        this.walkTimer = setInterval(() => {
            const elapsed = Date.now() - this.walkStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

            document.getElementById('walkingTime').textContent = timeStr;
        }, 1000);
    }

    async updateStats() {
        const stats = await this.dataManager.getStats();

        // 안전 점수 계산 (위험 감지 횟수 기반)
        const safetyScore = Math.max(0, 100 - (stats.totalDangers * 5));
        document.getElementById('safetyScore').textContent = safetyScore;

        // 보행 시간
        const walkMinutes = Math.floor(stats.totalWalkTime / 60000);
        document.getElementById('walkTime').textContent = `${walkMinutes}분`;

        // 위험 감지 횟수
        document.getElementById('dangerCount').textContent = `${stats.todayDangers}회`;
    }

    handleEmergency() {
        console.log('긴급 상황 발생!');

        // 진동 알림
        if (navigator.vibrate) {
            navigator.vibrate([500, 200, 500, 200, 500]);
        }

        // 위치 정보 가져오기
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const { latitude, longitude } = position.coords;
                    console.log(`긴급 위치: ${latitude}, ${longitude}`);

                    // TODO: 긴급 연락처로 위치 전송
                    this.uiController.showAlert('긴급 신호가 전송되었습니다', 'success');
                },
                (error) => {
                    console.error('위치 정보 획득 실패:', error);
                    this.uiController.showAlert('위치 정보를 가져올 수 없습니다', 'error');
                }
            );
        }
    }
}

// 앱 시작
const app = new SafeWalkApp();
document.addEventListener('DOMContentLoaded', () => app.init());