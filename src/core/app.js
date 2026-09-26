// SafeWalk AI - 메인 애플리케이션
import { DetectionManager } from '../detection/detectionManager.js';
import { WarningSystem } from '../warning/warningSystem.js';
import { UIController } from '../ui/uiController.js';
import { DataManager } from '../utils/dataManager.js';
import { debugLogger } from '../utils/debugLogger.js';
import { exportUnknownObjectQueue } from '../utils/unknownObjectExporter.js';
import { PlateScanManager } from '../plate/plateScanManager.js';
import { parsePlateCsv } from '../plate/plateMatcher.js';
import { exportPlateTestLog } from '../plate/plateTestLogExporter.js';
import { HazardSnapshotRecorder } from '../detection/hazardSnapshotRecorder.js';
import { exportHazardSnapshots } from '../utils/hazardSnapshotExporter.js';

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

        // 번호판 조회 모드 (관리자 도구) — 보행 안전 기능과 독립적인 별도 엔진
        this.plateScanManager = null;
        this.plateScanReady = false;
        this._plateScanInitInFlight = false; // 중복 시작 방지
        this._plateScanStopRequested = false; // 초기화 도중 정지 요청됐는지 (레이스 방지)

        // 위험요소 수동 스냅샷(맨홀/계단/에스컬레이터/웅덩이/싱크홀 등)
        this.hazardSnapshotRecorder = null;
        this.hazardSnapshotMode = 'photo'; // 'photo' | 'video'
        this._hazardSnapshotBusy = false; // 동영상 녹화(5초) 중 중복 요청 방지
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
        this.dataManager.purgeOldTestLog(); // 번호판 테스트 로그 자정 자동삭제 — 앱 열 때마다 점검

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
            // 감지 루프가 최근 큐에 추가한 항목이 디바운스된 localStorage 쓰기를
            // 아직 기다리고 있을 수 있다(detectionManager.js scheduleUnknownQueueFlush) —
            // 내보내기 전에 강제로 반영해 방금 잡은 항목이 누락되지 않게 한다.
            if (this.detectionManager) this.detectionManager.flushUnknownQueue();
            debugLogger.log('[오픈셋] 미지 객체 내보내는 중...');
            try {
                const { count, blob, filename } = await exportUnknownObjectQueue();
                if (count > 0) {
                    this.uiController.presentDownload(blob, filename, `미지 객체 ${count}개 ZIP 준비됨`);
                } else {
                    debugLogger.log('[오픈셋] 내보낼 미지 객체가 없습니다 (큐가 비어있음)');
                }
            } finally {
                btn.disabled = false;
            }
        });
        document.getElementById('btnDebugLogExport').addEventListener('click', () => {
            const { count, blob, filename } = debugLogger.exportAsText();
            if (count > 0) {
                this.uiController.presentDownload(blob, filename, `로그 ${count}줄 준비됨`);
            } else {
                debugLogger.log('[디버그] 내보낼 로그가 없습니다');
            }
        });

        // 뒤로 가기 버튼
        document.querySelectorAll('.btn-back').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget.dataset.back;
                // 번호판 조회 화면을 벗어날 때 카메라를 켜둔 채로 남기지 않는다
                if (this.uiController.currentScreen === 'plateScan') {
                    this.stopPlateScanning();
                }
                this.uiController.switchScreen(target);
            });
        });

        this.bindPlateScanEvents();
        this.bindHazardSnapshotEvents();

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
            if (document.visibilityState === 'hidden') {
                checkpointNow();
                this._hiddenAt = Date.now();
                // 번호판 조회 모드는 카메라를 계속 켜두면 배터리 소모 + 백그라운드에서
                // 인식 시도가 이어지는 문제가 있어 화면이 가려지면 바로 멈춘다.
                if (this.plateScanManager) this.stopPlateScanning();
            } else if (document.visibilityState === 'visible') {
                // 실측 로그(2026-09-26)에서 확인된 문제: 보행 모드 중 화면이 잠기면
                // 브라우저가 requestAnimationFrame을 강하게 스로틀링해(stage1 fps가
                // 0.7까지 떨어짐) 탐지가 사실상 멈추는데, 사용자에게는 아무 안내가
                // 없어 "위험 감지가 계속되고 있다"고 착각한 채 몇 초~수십 초를 걸을
                // 수 있다. 화면이 오래(5초 이상) 꺼져 있다 돌아왔을 때만 안내한다 —
                // 짧은 깜빡임까지 매번 경고하면 오히려 성가시다.
                const hiddenMs = this._hiddenAt ? Date.now() - this._hiddenAt : 0;
                this._hiddenAt = null;
                if (this.isWalking && hiddenMs > 5000) {
                    this.warningSystem.info('화면이 꺼진 동안 위험 감지가 중단되었습니다. 걷는 동안은 화면을 켜두세요');
                }
            }
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

        // 카메라 및 탐지 시작.
        // 실측(2026-09-19)에서 드러난 버그: init()이 카메라 권한+모델 로딩 때문에
        // 몇 초씩 걸리는데, 그 사이 사용자가 "정지"를 눌러 stopWalking()이 먼저 돌면
        // this.detectionManager가 null로 비워진다. 그 뒤 init()이 뒤늦게 끝나
        // this.detectionManager.onDetection에 대입하려는 순간
        // "Cannot set properties of null"로 죽었다 — this.detectionManager를 곧장
        // 쓰지 않고 지역변수에 담아뒀다가, 그래도 여전히 걷는 중일 때만 앱 상태에 반영한다.
        try {
            debugLogger.log('[카메라] DetectionManager 초기화 시작');
            const manager = new DetectionManager();
            await manager.init();

            if (!this.isWalking) {
                // 초기화하는 동안 이미 정지됨 — 방금 켠 카메라를 바로 해제하고 끝낸다
                manager.stop();
                debugLogger.log('[카메라] 초기화 도중 정지되어 카메라를 바로 해제했습니다');
                return;
            }

            this.detectionManager = manager;
            debugLogger.log('[카메라] 초기화 완료 (모델 로드 + getUserMedia 성공)');

            // 위험요소 수동 스냅샷 — detectionManager와 같은 비디오 스트림을 공유한다
            this.hazardSnapshotRecorder = new HazardSnapshotRecorder(this.detectionManager.video);

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
        this.hazardSnapshotRecorder = null;
        this.uiController.hideHazardSnapshotPanel();

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

    // 위험요소 수동 스냅샷 — 보행 중 맨홀/계단/에스컬레이터/웅덩이/싱크홀 등을 발견하면
    // 사용자가 직접 사진/동영상으로 기록해서 나중에 라벨링 데이터로 쓴다(2026-09-26).
    bindHazardSnapshotEvents() {
        const btnToggle = document.getElementById('btnHazardSnapshotToggle');
        const panel = document.getElementById('hazardSnapshotPanel');
        if (btnToggle && panel) {
            btnToggle.addEventListener('click', () => {
                panel.hidden = !panel.hidden;
            });
        }

        document.querySelectorAll('.hazard-mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.hazardSnapshotMode = btn.dataset.mode;
                document.querySelectorAll('.hazard-mode-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        document.querySelectorAll('.hazard-category-btn').forEach((btn) => {
            btn.addEventListener('click', () => this.captureHazardSnapshot(btn.dataset.category, btn));
        });

        const btnExport = document.getElementById('btnHazardExport');
        if (btnExport) {
            btnExport.addEventListener('click', async (e) => {
                const el = e.currentTarget;
                el.disabled = true;
                debugLogger.log('[위험요소] 스냅샷 내보내는 중...');
                try {
                    const { count, blob, filename } = await exportHazardSnapshots(this.dataManager);
                    if (count > 0) {
                        this.uiController.presentDownload(blob, filename, `위험요소 스냅샷 ${count}개 ZIP 준비됨`);
                    } else {
                        debugLogger.log('[위험요소] 내보낼 스냅샷이 없습니다');
                    }
                } finally {
                    el.disabled = false;
                }
            });
        }
    }

    async captureHazardSnapshot(category, btn) {
        if (!this.hazardSnapshotRecorder || this._hazardSnapshotBusy) return;
        this._hazardSnapshotBusy = true;

        try {
            let snapshot;
            if (this.hazardSnapshotMode === 'video') {
                btn.classList.add('recording');
                debugLogger.log(`[위험요소] ${category} 동영상 녹화 시작(5초)`);
                snapshot = await this.hazardSnapshotRecorder.recordVideo(category);
            } else {
                snapshot = this.hazardSnapshotRecorder.capturePhoto(category);
            }

            await this.dataManager.saveHazardSnapshot(snapshot);
            debugLogger.log(`[위험요소] ${category} ${snapshot.mediaType === 'video' ? '동영상' : '사진'} 저장 완료`);
            this.uiController.showAlert(`${category} 기록됨`, 'success');
        } catch (err) {
            debugLogger.log(`[위험요소] 기록 실패: ${err}`);
            this.uiController.showAlert('기록 실패', 'error');
        } finally {
            btn.classList.remove('recording');
            this._hazardSnapshotBusy = false;
        }
    }

    // 번호판 조회 모드 (관리자 도구, 테스트/파일럿용 — docs/지자체 체납차량 조회 시스템
    // 제안서 참고). 설정에서 "관리자 도구 표시"를 켜야 메인 화면에 진입 버튼이 보인다.
    bindPlateScanEvents() {
        const btnOpen = document.getElementById('btnPlateScanMode');
        if (btnOpen) {
            btnOpen.addEventListener('click', () => this.openPlateScan());
        }

        const csvInput = document.getElementById('plateCsvInput');
        if (csvInput) {
            csvInput.addEventListener('change', (e) => this.handlePlateCsvUpload(e.target.files[0]));
        }

        const btnCsvClear = document.getElementById('btnPlateCsvClear');
        if (btnCsvClear) {
            btnCsvClear.addEventListener('click', async () => {
                await this.dataManager.clearPlateList();
                this.plateScanManager?.setPlateList([]);
                this.uiController.updatePlateCsvSummary(0);
            });
        }

        const btnStart = document.getElementById('btnPlateScanStart');
        if (btnStart) {
            btnStart.addEventListener('click', () => this.startPlateScanning());
        }

        const btnStop = document.getElementById('btnPlateScanStop');
        if (btnStop) {
            btnStop.addEventListener('click', () => this.stopPlateScanning());
        }

        const btnCapture = document.getElementById('btnPlateCapture');
        if (btnCapture) {
            btnCapture.addEventListener('click', () => this.capturePlate());
        }

        const btnClearLog = document.getElementById('btnPlateScanClearLog');
        if (btnClearLog) {
            btnClearLog.addEventListener('click', async () => {
                await this.dataManager.clearPlateScans();
                this.refreshPlateScanLog();
            });
        }

        // 정확도 테스트 로그 (당일 한정, 자정 자동삭제) — 기본 OFF, 매칭 여부와
        // 무관하게 "오늘 인식된 번호판 텍스트"를 그날그날 확인하는 용도.
        const testLogToggle = document.getElementById('plateTestLogEnabled');
        if (testLogToggle) {
            testLogToggle.addEventListener('change', (e) => {
                localStorage.setItem('plateTestLogEnabled', String(e.target.checked));
            });
            testLogToggle.checked = localStorage.getItem('plateTestLogEnabled') === 'true';
        }

        const btnClearTestLog = document.getElementById('btnPlateTestLogClear');
        if (btnClearTestLog) {
            btnClearTestLog.addEventListener('click', async () => {
                await this.dataManager.clearTestLogNow();
                this.refreshPlateTestLog();
            });
        }

        const btnExportTestLog = document.getElementById('btnPlateTestLogExport');
        if (btnExportTestLog) {
            btnExportTestLog.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                    const entries = await this.dataManager.getTestLogForToday();
                    const { count, blob, filename } = await exportPlateTestLog(entries);
                    if (count > 0) {
                        this.uiController.presentDownload(blob, filename, `오늘 기록 ${count}건 ZIP 준비됨`);
                    } else {
                        debugLogger.log('[번호판조회] 내보낼 오늘 기록이 없습니다');
                    }
                } finally {
                    btn.disabled = false;
                }
            });
        }
    }

    async openPlateScan() {
        // 날짜가 바뀌었으면 전날 이전 테스트 로그를 먼저 정리 (자정 자동삭제 구현)
        await this.dataManager.purgeOldTestLog();
        const list = await this.dataManager.getPlateList();
        this.uiController.updatePlateCsvSummary(list.length);
        await this.refreshPlateScanLog();
        await this.refreshPlateTestLog();
        this.uiController.switchScreen('plateScan');
    }

    async refreshPlateScanLog() {
        const scans = await this.dataManager.getPlateScans();
        this.uiController.renderPlateScanLog(scans);
    }

    async refreshPlateTestLog() {
        const entries = await this.dataManager.getTestLogForToday();
        this.uiController.renderPlateTestLog(entries);
    }

    // 정확도 테스트 로그용 — 매칭 여부와 무관하게 OCR이 시도될 때마다 불림.
    // 옵트인(plateTestLogEnabled)이 꺼져 있으면 아무것도 저장하지 않는다.
    async handlePlateRecognized(rec) {
        if (localStorage.getItem('plateTestLogEnabled') !== 'true') return;
        await this.dataManager.saveTestLogEntry(rec);
        this.refreshPlateTestLog();
    }

    async handlePlateCsvUpload(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const records = parsePlateCsv(text);
            await this.dataManager.replacePlateList(records);
            this.plateScanManager?.setPlateList(records);
            this.uiController.updatePlateCsvSummary(records.length);
            debugLogger.log(`[번호판조회] CSV 업로드: ${records.length}건 로드`);
        } catch (err) {
            debugLogger.log(`[번호판조회] CSV 업로드 실패: ${err}`);
            this.uiController.showAlert('CSV 파일을 읽을 수 없습니다', 'error');
        }
    }

    // startWalking()과 같은 종류의 레이스가 여기도 있었다 — init() 도중 stopPlateScanning()이
    // 불리면 this.plateScanManager가 null이 된 뒤 init()이 뒤늦게 끝나면서 null에 접근해 죽는다.
    // 지역변수로 들고 있다가, 그래도 여전히 스캔 요청 상태일 때만 앱 상태에 반영한다.
    async startPlateScanning() {
        if (this._plateScanInitInFlight) return;
        if (this.plateScanManager) {
            this.plateScanManager.start();
            this.uiController.updatePlateScanStatus('준비됨 — 번호판을 프레임에 맞춘 뒤 인식 버튼을 누르세요');
            this.uiController.setPlateCaptureEnabled(true);
            return;
        }

        this._plateScanInitInFlight = true;
        this._plateScanStopRequested = false;
        this.uiController.updatePlateScanStatus('카메라/모델 준비 중...');
        try {
            const manager = new PlateScanManager();
            manager.onMatch = (match, cropDataUrl) => this.handlePlateMatch(match, cropDataUrl);
            manager.onStatus = (text) => this.uiController.updatePlateScanStatus(text);
            manager.onRecognized = (rec) => this.handlePlateRecognized(rec);
            manager.onCaptureResult = (result) => this.uiController.showPlateCaptureResult(result);
            await manager.init();

            if (this._plateScanStopRequested) {
                manager.stop();
                debugLogger.log('[번호판조회] 초기화 도중 정지되어 카메라를 바로 해제했습니다');
                this.uiController.updatePlateScanStatus('중지됨');
                return;
            }

            const list = await this.dataManager.getPlateList();
            manager.setPlateList(list);
            this.plateScanManager = manager;
            this.plateScanReady = true;
            manager.start();
            this.uiController.updatePlateScanStatus('준비됨 — 번호판을 프레임에 맞춘 뒤 인식 버튼을 누르세요');
            this.uiController.setPlateCaptureEnabled(true);
        } catch (err) {
            debugLogger.log(`[번호판조회] 시작 실패: ${err}`);
            this.uiController.showAlert('카메라를 시작할 수 없습니다', 'error');
        } finally {
            this._plateScanInitInFlight = false;
        }
    }

    stopPlateScanning() {
        this._plateScanStopRequested = true;
        if (this.plateScanManager) {
            this.plateScanManager.stop();
            this.plateScanManager = null;
            this.plateScanReady = false;
        }
        this.uiController.updatePlateScanStatus('중지됨');
        this.uiController.setPlateCaptureEnabled(false);
    }

    async capturePlate() {
        if (!this.plateScanManager) return;
        await this.plateScanManager.capture();
    }

    async handlePlateMatch(match, cropDataUrl) {
        await this.dataManager.savePlateScan({
            plate: match.plate,
            note: match.note,
            matchType: match.matchType,
            colorLabel: match.colorLabel,
            cropDataUrl
        });
        this.uiController.showPlateMatchAlert(match);
        this.warningSystem.info(`체납차량 발견, 번호판 ${match.plate}`);
        if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
        this.refreshPlateScanLog();
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