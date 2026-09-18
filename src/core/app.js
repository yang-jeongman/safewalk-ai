// SafeWalk AI - 메인 애플리케이션
import { DetectionManager } from '../detection/detectionManager.js';
import { WarningSystem } from '../warning/warningSystem.js';
import { UIController } from '../ui/uiController.js';
import { DataManager } from '../utils/dataManager.js';
import { debugLogger } from '../utils/debugLogger.js';
import { exportUnknownObjectQueue } from '../utils/unknownObjectExporter.js';

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
        this._lastRecordedEventTime = new Map(); // class -> timestamp, 리포트 기록용 쿨다운
        this.currentSessionId = null; // 체크포인트 upsert 대상 walkSessions row id
    }

    async init() {
        console.log('SafeWalk AI 초기화 중...');
        debugLogger.init();

        // Service Worker 등록
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('./sw.js');
                console.log('Service Worker 등록 완료');
                debugLogger.log('Service Worker 등록 완료');
            } catch (err) {
                console.error('Service Worker 등록 실패:', err);
                debugLogger.log(`Service Worker 등록 실패: ${err}`);
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
        document.getElementById('btnStart').addEventListener('click', () => {
            // 클릭(사용자 제스처)과 동기적으로 호출해야 iOS Safari에서 이후의
            // 비동기 speak() 호출이 무시되지 않는다.
            this.warningSystem.unlock();
            this.startWalking();
        });
        document.getElementById('btnStop').addEventListener('click', () => this.stopWalking());

        // 긴급 버튼
        document.getElementById('btnEmergency').addEventListener('click', () => this.handleEmergency());

        // 네비게이션
        document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const screen = e.currentTarget.dataset.screen;
                if (screen === 'report') {
                    await this.renderReport();
                }
                this.uiController.switchScreen(screen);
            });
        });

        // 설정 버튼
        document.getElementById('btnSettings').addEventListener('click', () => {
            this.uiController.switchScreen('settings');
        });

        // 디버그 패널
        document.getElementById('btnDebug').addEventListener('click', () => debugLogger.toggle());
        document.getElementById('btnDebugClose').addEventListener('click', () => debugLogger.hide());
        document.getElementById('btnDebugClear').addEventListener('click', () => debugLogger.clear());
        document.getElementById('btnDebugGate').addEventListener('click', () => {
            if (!this.detectionManager) {
                debugLogger.log('[모션게이트] 보행 모드가 시작된 뒤에만 토글할 수 있습니다');
                return;
            }
            this.detectionManager.toggleMotionGate();
        });
        document.getElementById('btnDebugExport').addEventListener('click', async (e) => {
            // 큐가 최대 150개까지 쌓일 수 있어 ZIP 생성에 수 초가 걸린다(비동기,
            // 청크 단위로 메인 스레드 양보 — unknownObjectExporter.js 참고). 그동안
            // 버튼을 비활성화해 연타로 인한 중복 내보내기를 막는다.
            const btn = e.currentTarget;
            btn.disabled = true;
            debugLogger.log('[오픈셋] 미지 객체 내보내는 중...');
            try {
                const { count } = await exportUnknownObjectQueue();
                debugLogger.log(count > 0
                    ? `[오픈셋] 미지 객체 ${count}개를 ZIP으로 내보냈습니다`
                    : '[오픈셋] 내보낼 미지 객체가 없습니다 (큐가 비어있음)');
            } finally {
                btn.disabled = false;
            }
        });

        // 뒤로 가기 버튼
        document.querySelectorAll('.btn-back').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget.dataset.back;
                this.uiController.switchScreen(target);
            });
        });

        // 화면이 백그라운드로 가거나(앱 전환, 화면 잠금) 탭/앱이 실제로 닫히는 시점 —
        // 20초 주기 체크포인트(startWalkTimer)만으로는 그 사이 구간이 통째로 빌 수 있고,
        // 모바일에서 setInterval은 백그라운드 시 스로틀/정지될 수 있어 더더욱 그렇다.
        // beforeunload는 iOS Safari에서 신뢰할 수 없어 visibilitychange/pagehide를 쓴다.
        const checkpointNow = () => {
            if (!this.isWalking || !this.walkStartTime) return;
            this.dataManager.saveWalkSession({
                duration: Date.now() - this.walkStartTime,
                dangerCount: this.dangerCount,
                timestamp: this.walkStartTime
            }, { id: this.currentSessionId, updateDailyStats: false })
                .then((id) => { this.currentSessionId = id; })
                .catch(() => {});
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') checkpointNow();
        });
        window.addEventListener('pagehide', checkpointNow);
    }

    async startWalking() {
        if (this.isWalking) return;

        console.log('보행 모드 시작');
        this.isWalking = true;
        this.walkStartTime = Date.now();
        this.dangerCount = 0;
        this._lastRecordedEventTime.clear();
        this.currentSessionId = null;

        // UI 전환
        this.uiController.switchScreen('walking');
        this.uiController.updateStatus('walking', { status: 'active' });

        // 카메라 및 탐지 시작
        try {
            debugLogger.log('[카메라] DetectionManager 초기화 시작');
            this.detectionManager = new DetectionManager();
            await this.detectionManager.init();
            debugLogger.log('[카메라] 초기화 완료 (모델 로드 + getUserMedia 성공)');

            // 탐지 콜백 설정
            this.detectionManager.onDetection = (threats) => this.handleDetection(threats);

            // 탐지 시작
            await this.detectionManager.start();
            debugLogger.log('[카메라] 탐지 루프 시작');

            // 타이머 시작
            this.startWalkTimer();

        } catch (error) {
            console.error('카메라 시작 실패:', error);
            debugLogger.log(`[카메라] 시작 실패: ${error}`);
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

        // 데이터 저장 — 정상 종료 시의 최종 저장. 중간 체크포인트(startWalkTimer 참고)로
        // 이미 만들어진 row가 있으면 그 row를 갱신하며 dailyStats에 정확히 한 번 반영한다.
        const walkDuration = Date.now() - this.walkStartTime;
        this.dataManager.saveWalkSession({
            duration: walkDuration,
            dangerCount: this.dangerCount,
            timestamp: this.walkStartTime
        }, { id: this.currentSessionId, updateDailyStats: true });
        this.currentSessionId = null;

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
        // dangerCount는 홈 화면 요약 수치와 리포트 상단 카드(walkSession.dangerCount)의
        // 근거이기도 하다 — recordDangerEvent()와 같은 쿨다운 판단을 쓰지 않으면 "자주
        // 감지된 물체" 목록(dangerEvents 기반)과 상단 요약 숫자가 서로 다른 카운터라
        // 불일치하게 된다. recordDangerEvent()가 실제로 기록했을 때만 증가시켜 맞춘다.
        if (mostDangerous.level > 0.7) {
            this.warningSystem.alert(mostDangerous);
            this.uiController.showDanger(mostDangerous);
            if (this.recordDangerEvent(mostDangerous)) this.dangerCount++;
        } else if (mostDangerous.level > 0.4) {
            this.warningSystem.warn(mostDangerous);
            this.uiController.showWarning(mostDangerous);
            this.recordDangerEvent(mostDangerous);
        }

        // 위험도 UI 업데이트
        this.uiController.updateDangerLevel(mostDangerous.level);
    }

    // 리포트 화면의 "자주 감지된 물체" 통계용 — dataManager.saveDangerEvent()는
    // 원래부터 있었지만 실제로 호출하는 곳이 없어 dangerEvents가 항상 비어있었다.
    //
    // 실측(2026-09-18)에서 드러난 문제: 음성 경고엔 쿨다운(2~3초)이 있어 안 시끄러웠지만,
    // 이 기록 자체엔 쿨다운이 없었다. 같은 물체(예: 지나치는 기둥)가 화면에 몇 초만
    // 머물러도 감지 사이클(300ms)마다 별도 이벤트로 기록되어, "한 번의 마주침"이
    // 통계엔 10~15건으로 부풀려졌다. 클래스별 쿨다운으로 "같은 마주침"을 한 건으로 묶는다.
    // 반환값: 이번 호출이 실제로 기록됐는지(쿨다운에 걸려 무시됐으면 false) —
    // 호출 쪽에서 dangerCount 등 다른 집계도 같은 판단 기준으로 맞추는 데 쓴다.
    recordDangerEvent(threat) {
        const now = Date.now();
        const lastTime = this._lastRecordedEventTime.get(threat.class) || 0;
        const cooldownMs = 3000;
        if (now - lastTime < cooldownMs) return false;

        this._lastRecordedEventTime.set(threat.class, now);
        this.dataManager.saveDangerEvent({
            sessionId: this.walkStartTime,
            objectClass: threat.class,
            threatLevel: threat.level,
            distance: threat.distance,
            direction: threat.direction
        });
        return true;
    }

    async renderReport() {
        const [stats, patterns] = await Promise.all([
            this.dataManager.getStats(),
            this.dataManager.analyzeDangerPatterns()
        ]);
        this.uiController.renderReport(stats, patterns);
    }

    startWalkTimer() {
        let tickCount = 0;
        this.walkTimer = setInterval(() => {
            const elapsed = Date.now() - this.walkStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

            document.getElementById('walkingTime').textContent = timeStr;

            // 20초마다 체크포인트 저장 — "정지" 버튼 없이 앱이 강제 종료/새로고침돼도
            // 최소한 마지막 체크포인트 시점까지는 리포트의 보행 기록에 남도록 한다.
            // dailyStats는 여기서 건드리지 않는다(stopWalking에서 최종 1회만 반영 —
            // 안 그러면 체크포인트마다 누적치를 중복 합산하게 된다).
            tickCount++;
            if (tickCount % 20 === 0) {
                this.dataManager.saveWalkSession({
                    duration: elapsed,
                    dangerCount: this.dangerCount,
                    timestamp: this.walkStartTime
                }, { id: this.currentSessionId, updateDailyStats: false })
                    .then((id) => { this.currentSessionId = id; })
                    .catch((err) => debugLogger.log(`[체크포인트] 저장 실패: ${err}`));
            }
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