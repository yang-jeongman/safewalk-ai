// Service Worker - 오프라인 지원 및 캐싱
const CACHE_NAME = 'safewalk-v1';
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './src/ui/styles.css',
    './src/core/app.js',
    './src/detection/detectionManager.js',
    './src/warning/warningSystem.js',
    './src/ui/uiController.js',
    './src/utils/dataManager.js',
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

// Fetch 이벤트 - 캐시 우선 전략
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // 캐시에서 찾으면 반환
                if (response) {
                    return response;
                }

                // 네트워크 요청
                return fetch(event.request).then((response) => {
                    // 유효한 응답이 아니면 그대로 반환
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }

                    // 응답 복제 (캐시용, 반환용)
                    const responseToCache = response.clone();

                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });

                    return response;
                });
            })
            .catch(() => {
                // 오프라인 폴백
                if (event.request.destination === 'document') {
                    return caches.match('./index.html');
                }
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