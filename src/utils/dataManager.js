// 데이터 관리 모듈 - IndexedDB 사용
export class DataManager {
    constructor() {
        this.dbName = 'SafeWalkDB';
        // v2: 번호판 조회 모드(관리자 도구, 2026-09-19) 스토어 추가 — 기존 스토어는 그대로 유지.
        this.dbVersion = 2;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('데이터베이스 열기 실패');
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('데이터베이스 연결 성공');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 보행 세션 스토어
                if (!db.objectStoreNames.contains('walkSessions')) {
                    const walkStore = db.createObjectStore('walkSessions', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    walkStore.createIndex('timestamp', 'timestamp', { unique: false });
                    walkStore.createIndex('date', 'date', { unique: false });
                }

                // 위험 감지 기록 스토어
                if (!db.objectStoreNames.contains('dangerEvents')) {
                    const dangerStore = db.createObjectStore('dangerEvents', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    dangerStore.createIndex('sessionId', 'sessionId', { unique: false });
                    dangerStore.createIndex('timestamp', 'timestamp', { unique: false });
                    dangerStore.createIndex('objectClass', 'objectClass', { unique: false });
                }

                // 일일 통계 스토어
                if (!db.objectStoreNames.contains('dailyStats')) {
                    const statsStore = db.createObjectStore('dailyStats', {
                        keyPath: 'date'
                    });
                }

                // 번호판 조회 모드(관리자 도구) — 업로드한 체납차량 목록. 기기 로컬에만
                // 저장되고 서버로 전송되지 않는다 (docs/제안서 "서버 없음, CSV 업로드" 원칙).
                if (!db.objectStoreNames.contains('delinquentPlates')) {
                    db.createObjectStore('delinquentPlates', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                }

                // 번호판 조회 모드 — 매칭된 건만 기록한다. 매칭 안 된(=무고한) 차량의
                // 크롭·인식 텍스트는 애초에 이 스토어에 들어오지 않는다 (plateScanManager.js
                // 설계 원칙 — 행인/무관 차량 데이터 최소 수집).
                if (!db.objectStoreNames.contains('plateScans')) {
                    const plateScanStore = db.createObjectStore('plateScans', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    plateScanStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                console.log('데이터베이스 스키마 생성 완료');
            };
        });
    }

    // 보행 세션 저장/갱신.
    // options.id가 있으면 기존 레코드를 그 자리에서 갱신(체크포인트용), 없으면 새로 생성.
    // options.updateDailyStats가 true일 때만 dailyStats 누적에 반영한다 — 세션당 정확히
    // 한 번만(보통 종료 시) true로 호출해야 이중 집계를 피할 수 있다. 중간 체크포인트는
    // false로 호출해 walkSessions 레코드만 최신 상태로 유지한다.
    //
    // 도입 이유(2026-09-19): 앱을 "정지" 버튼 없이 실수로 닫으면 stopWalking()이 한 번도
    // 안 불려서 그 세션이 walkSessions에 아예 안 남았다 — 개별 위험 이벤트(dangerEvents)는
    // saveDangerEvent()로 즉시 저장돼 살아있는데 세션 요약만 통째로 사라지는 불일치가 있었다.
    // 주기적 체크포인트로 최소한 마지막 체크포인트 시점까지는 리포트에 남도록 한다.
    async saveWalkSession(sessionData, options = {}) {
        const { id = null, updateDailyStats = true } = options;
        const transaction = this.db.transaction(['walkSessions', 'dailyStats'], 'readwrite');
        const walkStore = transaction.objectStore('walkSessions');
        const statsStore = transaction.objectStore('dailyStats');

        // 세션 데이터 준비
        const session = {
            timestamp: sessionData.timestamp || Date.now(),
            date: new Date().toISOString().split('T')[0],
            duration: sessionData.duration,
            dangerCount: sessionData.dangerCount,
            distance: sessionData.distance || 0,
            safetyScore: this.calculateSafetyScore(sessionData)
        };
        if (id !== null) session.id = id;

        // id가 있으면 그 레코드를 덮어쓰고(체크포인트 갱신), 없으면 새로 만든다
        const sessionRequest = id !== null ? walkStore.put(session) : walkStore.add(session);

        let savedId = id;
        sessionRequest.onsuccess = async () => {
            savedId = sessionRequest.result;

            if (!updateDailyStats) return;

            // 일일 통계 업데이트
            const date = session.date;
            const statsRequest = statsStore.get(date);

            statsRequest.onsuccess = () => {
                const existingStats = statsRequest.result || {
                    date: date,
                    totalWalkTime: 0,
                    totalDistance: 0,
                    totalDangers: 0,
                    sessionCount: 0,
                    avgSafetyScore: 0
                };

                // 통계 업데이트
                existingStats.totalWalkTime += session.duration;
                existingStats.totalDistance += session.distance;
                existingStats.totalDangers += session.dangerCount;
                existingStats.sessionCount += 1;
                existingStats.avgSafetyScore =
                    (existingStats.avgSafetyScore * (existingStats.sessionCount - 1) + session.safetyScore)
                    / existingStats.sessionCount;

                statsStore.put(existingStats);
            };
        };

        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve(savedId);
        });
    }

    // 위험 이벤트 저장
    async saveDangerEvent(eventData) {
        const transaction = this.db.transaction(['dangerEvents'], 'readwrite');
        const store = transaction.objectStore('dangerEvents');

        const event = {
            sessionId: eventData.sessionId,
            timestamp: Date.now(),
            objectClass: eventData.objectClass,
            threatLevel: eventData.threatLevel,
            distance: eventData.distance,
            direction: eventData.direction,
            location: eventData.location || null
        };

        store.add(event);

        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve();
        });
    }

    // 번호판 조회 모드 — CSV로 업로드한 체납차량 목록을 통째로 교체한다.
    // records: [{ plate, note }] — plate는 plateMatcher.normalizePlate()로 이미 정규화된 값.
    async replacePlateList(records) {
        const transaction = this.db.transaction(['delinquentPlates'], 'readwrite');
        const store = transaction.objectStore('delinquentPlates');
        store.clear();
        for (const record of records) {
            store.add({ plate: record.plate, note: record.note || '' });
        }
        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve();
        });
    }

    async getPlateList() {
        return this.getAllFromStore('delinquentPlates');
    }

    async clearPlateList() {
        const transaction = this.db.transaction(['delinquentPlates'], 'readwrite');
        transaction.objectStore('delinquentPlates').clear();
        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve();
        });
    }

    // 번호판 조회 모드 — 매칭된 건만 기록 (plateScanManager.js가 매칭 안 된 건 애초에 호출 안 함)
    async savePlateScan(scan) {
        const transaction = this.db.transaction(['plateScans'], 'readwrite');
        const store = transaction.objectStore('plateScans');
        store.add({
            timestamp: Date.now(),
            plate: scan.plate,
            note: scan.note || '',
            matchType: scan.matchType,
            cropDataUrl: scan.cropDataUrl || null,
            location: scan.location || null
        });
        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve();
        });
    }

    async getPlateScans() {
        const scans = await this.getAllFromStore('plateScans');
        return scans.sort((a, b) => b.timestamp - a.timestamp);
    }

    async clearPlateScans() {
        const transaction = this.db.transaction(['plateScans'], 'readwrite');
        transaction.objectStore('plateScans').clear();
        return new Promise((resolve) => {
            transaction.oncomplete = () => resolve();
        });
    }

    // 통계 조회
    async getStats() {
        const today = new Date().toISOString().split('T')[0];
        const stats = {
            totalWalkTime: 0,
            totalDistance: 0,
            todayDangers: 0,
            totalDangers: 0,
            avgSafetyScore: 0,
            recentSessions: []
        };

        // 오늘의 통계
        const transaction = this.db.transaction(['dailyStats', 'walkSessions'], 'readonly');
        const statsStore = transaction.objectStore('dailyStats');
        const walkStore = transaction.objectStore('walkSessions');

        // 오늘 통계 가져오기
        const todayStats = await this.getFromStore(statsStore, today);
        if (todayStats) {
            stats.totalWalkTime = todayStats.totalWalkTime;
            stats.totalDistance = todayStats.totalDistance;
            stats.todayDangers = todayStats.totalDangers;
            stats.avgSafetyScore = Math.round(todayStats.avgSafetyScore);
        }

        // 최근 7일 통계
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const range = IDBKeyRange.lowerBound(weekAgo.getTime());
        const index = walkStore.index('timestamp');
        const request = index.openCursor(range);

        return new Promise((resolve) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    stats.recentSessions.push(cursor.value);
                    stats.totalDangers += cursor.value.dangerCount || 0;
                    cursor.continue();
                } else {
                    resolve(stats);
                }
            };
        });
    }

    // 보행 기록 조회
    async getWalkHistory(days = 30) {
        const transaction = this.db.transaction(['walkSessions'], 'readonly');
        const store = transaction.objectStore('walkSessions');
        const index = store.index('timestamp');

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const range = IDBKeyRange.lowerBound(startDate.getTime());

        const sessions = [];
        const request = index.openCursor(range);

        return new Promise((resolve) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    sessions.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(sessions);
                }
            };
        });
    }

    // 위험 패턴 분석
    async analyzeDangerPatterns() {
        const transaction = this.db.transaction(['dangerEvents'], 'readonly');
        const store = transaction.objectStore('dangerEvents');

        const patterns = {
            mostFrequentObject: {},
            dangerousTimes: {},
            dangerousLocations: []
        };

        const request = store.openCursor();

        return new Promise((resolve) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const event = cursor.value;

                    // 객체별 빈도
                    patterns.mostFrequentObject[event.objectClass] =
                        (patterns.mostFrequentObject[event.objectClass] || 0) + 1;

                    // 시간대별 분석
                    const hour = new Date(event.timestamp).getHours();
                    patterns.dangerousTimes[hour] =
                        (patterns.dangerousTimes[hour] || 0) + 1;

                    cursor.continue();
                } else {
                    resolve(patterns);
                }
            };
        });
    }

    // 안전 점수 계산
    calculateSafetyScore(sessionData) {
        const { duration, dangerCount } = sessionData;
        const minutesDuration = duration / 60000;

        // 분당 위험 감지 횟수
        const dangerPerMinute = dangerCount / Math.max(1, minutesDuration);

        // 점수 계산 (100점 만점)
        let score = 100;
        score -= dangerPerMinute * 10; // 분당 위험 1회당 -10점
        score = Math.max(0, Math.min(100, score));

        return Math.round(score);
    }

    // 데이터 내보내기
    async exportData() {
        const data = {
            walkSessions: await this.getAllFromStore('walkSessions'),
            dangerEvents: await this.getAllFromStore('dangerEvents'),
            dailyStats: await this.getAllFromStore('dailyStats')
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `safewalk-data-${new Date().toISOString().split('T')[0]}.json`;
        a.click();

        URL.revokeObjectURL(url);
    }

    // 도우미 메서드
    getFromStore(store, key) {
        return new Promise((resolve) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
        });
    }

    getAllFromStore(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // 데이터 초기화
    async clearAllData() {
        const transaction = this.db.transaction(
            ['walkSessions', 'dangerEvents', 'dailyStats'],
            'readwrite'
        );

        transaction.objectStore('walkSessions').clear();
        transaction.objectStore('dangerEvents').clear();
        transaction.objectStore('dailyStats').clear();

        return new Promise((resolve) => {
            transaction.oncomplete = () => {
                console.log('모든 데이터 초기화 완료');
                resolve();
            };
        });
    }
}