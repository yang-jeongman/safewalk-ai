// 데이터 관리 모듈 - IndexedDB 사용
export class DataManager {
    constructor() {
        this.dbName = 'SafeWalkDB';
        this.dbVersion = 1;
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

                console.log('데이터베이스 스키마 생성 완료');
            };
        });
    }

    // 보행 세션 저장
    async saveWalkSession(sessionData) {
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

        // 세션 저장
        const sessionRequest = walkStore.add(session);

        sessionRequest.onsuccess = async () => {
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
            transaction.oncomplete = () => resolve();
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