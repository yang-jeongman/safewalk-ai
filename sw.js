// Service Worker - 오프라인 지원 및 캐싱
const CACHE_NAME = 'safewalk-v4'; // 횡단보도/신호등 전용 모델 추가(2026-09-26)로 캐시 목록이 바뀌어 버전업
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './src/ui/styles.css',
    './src/core/app.js',
    './src/detection/detectionManager.js',
    './src/detection/motionGate.js',
    './src/detection/poleGate.js',
    './src/detection/objectTracker.js',
    './src/detection/objectEmbedding.js',
    './src/detection/knownObjectGallery.js',
    './src/detection/trafficLightColor.js',
    './src/detection/onnxCrosswalkDetector.js',
    './src/detection/hazardSnapshotRecorder.js',
    './src/detection/sharpness.js',
    './src/warning/warningSystem.js',
    './src/ui/uiController.js',
    './src/utils/dataManager.js',
    './src/utils/debugLogger.js',
    './src/utils/objectNames.js',
    './src/utils/unknownObjectExporter.js',
    './src/utils/hazardSnapshotExporter.js',
    './src/utils/zipWriter.js',
    './src/plate/plateScanManager.js',
    './src/plate/onnxModels.js',
    './src/plate/onnxPlateDetector.js',
    './src/plate/onnxCharacterReader.js',
    './src/plate/plateMatcher.js',
    './src/plate/plateColor.js',
    './src/plate/plateTestLogExporter.js',
    './data/known-objects-gallery.json',
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet'
    // onnxruntime-web과 models/*.onnx(12MB+104MB)는 일부러 설치 시점 미리캐시
    // 목록에서 뺐다 — 번호판 조회(관리자 도구)를 실제로 켠 사람만 그때 받도록.
    // 여기 넣으면 일반 보행자 사용자도 PWA 설치 때마다 116MB를 강제로 받게 된다.
    // 실제로 그 화면을 켜면 sw.js의 네트워크우선 fetch 핸들러가 첫 로드 후 알아서
    // 캐시해서 다음부터는 오프라인에서도 쓸 수 있다.
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
    const url = new URL(event.request.url);
    const isSameOrigin = url.origin === self.location.origin;
    const isModelWeights = url.pathname.includes('/models/') && url.pathname.endsWith('.onnx');

    if (!isSameOrigin || isModelWeights) {
        // 외부 CDN(tfjs, coco-ssd)과 마찬가지로 ONNX 모델 가중치(같은 출처지만 12MB+
        // 104MB로 큼)도 캐시 우선으로 둔다 — 내용이 안 바뀌는 파일인데 번호판 조회
        // 화면 켤 때마다 116MB를 매번 재다운로드하면 안 되므로. 모델을 바꿀 땐
        // 파일명 자체를 바꾸는 방식으로 캐시 무효화한다.
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