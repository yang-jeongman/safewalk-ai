// Service Worker - 오프라인 지원 및 캐싱
const CACHE_NAME = 'safewalk-v2';
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './src/ui/styles.css',
    './src/core/app.js',
    './src/detection/detectionManager.js',
    './src/detection/motionGate.js',
    './src/warning/warningSystem.js',
    './src/ui/uiController.js',
    './src/utils/dataManager.js',
    './src/utils/debugLogger.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd'
];

// 설치 이벤트
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('캐시 열기 완료');
                return cache.addAll(urlsToCache);
            })
            .then(() => {
                console.log('모든 리소스 캐싱 완료');
                return self.skipWaiting();
            })
    );
});

// 활성화 이벤트
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('이전 캐시 삭제:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// Fetch 이벤트 - 네트워크 우선 전략(같은 출처 파일).
// 캐시 우선으로 두면 sw.js 자체가 바뀌지 않은 배포에서는 서비스 워커가
// "업데이트할 게 없다"고 판단해 오래된 JS를 계속 서빙한다 — 한창 반복
// 수정 중인 프로토타입 단계에는 치명적이라 네트워크 우선으로 바꾼다.
// (완전 오프라인일 때만 캐시로 폴백 — 오프라인 지원 취지는 유지)
self.addEventListener('fetch', (event) => {
    const isSameOrigin = new URL(event.request.url).origin === self.location.origin;

    if (!isSameOrigin) {
        // 외부 CDN(tfjs, coco-ssd)은 그대로 캐시 우선 유지 — 버전 고정 URL이라 안전
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => {
                // 오프라인일 때만 캐시로 폴백
                return caches.match(event.request).then((cached) => {
                    if (cached) return cached;
                    if (event.request.destination === 'document') {
                        return caches.match('./index.html');
                    }
                });
            })
    );
});

// 백그라운드 동기화
self.addEventListener('sync', (event) => {
    if (event.tag === 'upload-walk-data') {
        event.waitUntil(uploadWalkData());
    }
});

// 푸시 알림
self.addEventListener('push', (event) => {
    const options = {
        body: event.data ? event.data.text() : '새로운 알림이 있습니다',
        icon: './public/assets/icons/icon-192.png',
        badge: './public/assets/icons/icon-72.png',
        vibrate: [200, 100, 200],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        }
    };

    event.waitUntil(
        self.registration.showNotification('SafeWalk AI', options)
    );
});

// 알림 클릭 처리
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil(
        clients.openWindow('./')
    );
});

// 백그라운드 데이터 업로드
async function uploadWalkData() {
    try {
        // IndexedDB에서 데이터 가져오기
        const db = await openDB();
        const data = await getUnsyncedData(db);

        if (data.length > 0) {
            // 서버로 전송 (향후 구현)
            console.log('데이터 동기화:', data);
        }
    } catch (error) {
        console.error('데이터 동기화 실패:', error);
    }
}

// IndexedDB 헬퍼 함수
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('SafeWalkDB', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getUnsyncedData(db) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['walkSessions'], 'readonly');
        const store = transaction.objectStore('walkSessions');
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}