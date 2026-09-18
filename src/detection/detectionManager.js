// 객체 탐지 관리 모듈
import { MotionGate } from './motionGate.js';
import { PoleGate } from './poleGate.js';
import { ObjectTracker } from './objectTracker.js';
import { ObjectEmbedding } from './objectEmbedding.js';
import { KnownObjectGallery } from './knownObjectGallery.js';
import { classifyTrafficLightColor } from './trafficLightColor.js';
import { estimateSharpness } from './sharpness.js';
import { debugLogger } from '../utils/debugLogger.js';

export class DetectionManager {
    constructor() {
        this.model = null;
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.isDetecting = false;
        this.onDetection = null; // 콜백 함수

        // 1단계(모션 게이트)
        this.motionGate = null;
        this.motionGateEnabled = true; // Phase 1 실측 비교용 런타임 토글

        // 실기기 실측 결과, video→canvas 리드백(drawImage+getImageData)이 이
        // 기기에서 매우 비싸서(수십ms) 매 rAF마다 부르면 루프 자체가 느려졌다.
        // 게이트 샘플링을 별도 주기로 제한해 리드백 횟수를 줄인다.
        this.motionGateSampleIntervalMs = 60; // ~16Hz — stage2 기본 주기보다는 훨씬 촘촘함
        this._lastGateSampleTime = 0;
        this._lastGateResult = { looming: false, urgency: 0, tau: Infinity };

        // 기둥 게이트 — 전봇대/기둥처럼 COCO-SSD가 모르는 수직 구조물을 접근 여부(looming)와
        // 무관하게 항상 감지 (사용자 피드백 2026-09-17: "전봇대·기둥 인식률 낮음")
        this.poleGate = null;
        this.poleGateEnabled = true;
        this.poleGateSampleIntervalMs = 150; // 모션게이트보다 그리드가 커서 조금 느슨한 주기
        this._lastPoleSampleTime = 0;
        this._lastPoleResult = { detected: false, bbox: null };

        // 객체 추적 — 차량/오토바이/자전거 진행방향 화살표(사용자 요청 2026-09-19)용.
        // 비디오 없이도 만들 수 있어 생성자에서 바로 초기화.
        this.tracker = new ObjectTracker();
        // 진행방향 화살표를 그릴 대상 클래스 — 정지 표지판/신호등처럼 안 움직이는
        // 것들은 방향이 의미 없으므로 제외.
        this.trackedClasses = new Set(['car', 'bus', 'truck', 'motorcycle', 'bicycle']);

        // 2단계(COCO-SSD) 스케줄링
        // 안전 원칙: 기본 주기는 절대 생략하지 않는다. 모션 게이트는 오직
        // 이 주기를 "앞당기는" 용도로만 쓴다 (브리프 §3.1).
        this.stage2BaseIntervalMs = 300; // 기본 주기 — 실측 후 조정 필요
        this.stage2MinGapOnLoomingMs = 80; // looming 시에도 프레임마다 재요청 방지
        this.lastStage2Time = 0;
        this._stage2Running = false;

        // 실측용 카운터 (배터리/프레임레이트 비교)
        this._perfStage1Count = 0;
        this._perfStage2Count = 0;
        this._perfWindowStart = 0;

        // Phase 2: open-set 객체 인식 (docs/phase2-design.md)
        // COCO-SSD 저confidence 박스만 임베딩으로 재확인 — 전체를 다시 돌리지 않는다.
        this.embedding = null;
        this.knownGallery = null;
        this.openSetEnabled = true;
        this.lowConfidenceThreshold = 0.6; // 이보다 낮은 score만 재확인 대상
        this.knownSimilarityThreshold = 0.7; // 실측 후 조정 필요
        this.maxEmbeddingChecksPerCycle = 2; // 사이클당 재확인 상한 (비용 제한)
        this._cropCanvas = null;
        // 분산-오브-라플라시안(src/detection/sharpness.js) 임계값. 실제 사용자가 보내준
        // 크롭 샘플로 캘리브레이션(2026-09-18): 블러 심한 것들은 4~40, 또렷한 것들은
        // 439~1969로 큰 간격이 있어 그 사이인 100으로 설정. 표본이 적어 향후 데이터가
        // 더 쌓이면 재조정 필요.
        this.minCropSharpness = 100;

        // 걷는 거리에서 현실적으로 등장할 수 있는 COCO-SSD 클래스만 그대로 신뢰한다.
        // 실사용 리포트에서 "elephant", "remote"처럼 이 상황에 나올 수 없는 클래스가
        // 확인됨(2026-09-17) — COCO-SSD가 confidence 0.6 이상으로 "자신 있게" 틀리면
        // lowConfidenceThreshold 기반 재확인을 아예 안 거치고 그대로 통과했던 게 원인.
        // confidence와 무관하게, 도메인 밖 클래스는 무조건 재확인(→ 미지 처리) 대상에 넣는다.
        this.domainRelevantClasses = new Set([
            'person', 'car', 'bus', 'truck', 'motorcycle', 'bicycle',
            'traffic light', 'stop sign', 'bench',
            'fire hydrant', 'parking meter', 'potted plant', 'chair',
            'dog', 'cat', 'umbrella', 'backpack', 'suitcase', 'handbag'
        ]);

        // 위험 객체 정의
        this.threatLevels = {
            'car': 0.9,
            'bus': 0.9,
            'truck': 0.9,
            'motorcycle': 0.8,
            'bicycle': 0.7,
            'person': 0.5,
            'traffic light': 0.4,
            'stop sign': 0.4,
            'bench': 0.1, // 정적 시설물, 낮은 위협도 (open-set 갤러리에 첫 항목 추가됨)
            // 미지 객체는 절대 "안전"으로 취급하지 않는다 — 사람과 동급 기본 위협도
            // (브리프 §3.2 안전 원칙: 미지 = 저위험이 아니라 "정체불명의 물체"로 중간 위협도)
            'unknown': 0.5,
            // 벽/기둥/전봇대 등 COCO-SSD가 아예 모르는 정면 장애물 — 모션게이트가
            // 급격한 접근(looming)을 감지했을 때 합성한 항목. 실제로 부딪힐 수 있는
            // 물리적 장애물이라 차량급으로 취급.
            'obstacle': 0.7,
            // 전봇대/기둥 등 "길고 가는 수직 구조물" — 기둥게이트가 접근 여부와 무관하게
            // 상시 감지(poleGate.js). 정밀 분류가 아닌 기하학적 추정이라 obstacle보다는
            // 낮게, 사람과 비슷한 수준으로 취급.
            'pole': 0.6,
            // open-set 갤러리 항목 (2026-09-18, 실사용자 "clock"/"fire_hydrant" 오분류 크롭에서 발견).
            // 맨홀 뚜껑: 평평하게 지면과 같은 높이라 충돌 위험은 낮음 — 정보성 수준으로만 알림.
            'manhole': 0.15,
            // 볼라드: 보행로 한가운데 고정된 낮은 기둥으로, 시각장애인 보행 사고의 대표
            // 원인 중 하나 — 전봇대/기둥(pole)과 동급의 실질적 충돌 위험으로 취급.
            'bollard': 0.6
        };

        // 아이콘 매핑
        this.iconMap = {
            'person': '👤',
            'car': '🚗',
            'bus': '🚌',
            'truck': '🚚',
            'bicycle': '🚲',
            'motorcycle': '🏍️',
            'traffic light': '🚦',
            'stop sign': '🛑',
            'obstacle': '🧱',
            'pole': '🪧',
            'bench': '🪑',
            'manhole': '🕳️',
            'bollard': '🚧'
        };
    }

    async init() {
        console.log('탐지 시스템 초기화 중...');

        // 비디오 및 캔버스 설정
        this.video = document.getElementById('videoElement');
        this.canvas = document.getElementById('canvasOverlay');
        this.ctx = this.canvas.getContext('2d');

        // 카메라 스트림 설정
        await this.setupCamera();

        // 1단계(모션 게이트) 준비
        this.motionGate = new MotionGate(this.video);

        // 기둥 게이트 준비 — 실패해도 나머지 탐지는 그대로 동작
        if (this.poleGateEnabled) {
            try {
                this.poleGate = new PoleGate(this.video);
            } catch (err) {
                console.error('기둥 게이트 초기화 실패:', err);
                this.poleGate = null;
            }
        }

        // COCO-SSD 모델 로드.
        // mobilenet_v2(원거리 신호등 인식 개선용, 2026-09-17)로 전환했다가 실기기 실측
        // (2026-09-19)에서 stage1이 1~4fps까지 떨어지는 것을 확인 — 그 커밋 자체가
        // "느려지면 되돌릴 것"이라 명시해둔 상황. 반응속도가 실제 안전과 직결되므로
        // 원거리 신호등 인식 개선보다 프레임레이트를 우선해 되돌린다.
        console.log('AI 모델 로딩 중...');
        this.cocoSsdBase = 'lite_mobilenet_v2';
        this.model = await cocoSsd.load({ base: this.cocoSsdBase });
        console.log(`AI 모델 로드 완료 (base=${this.cocoSsdBase})`);

        // Phase 2: open-set 인식 준비 — 실패해도 COCO-SSD 단독 동작은 막지 않는다
        if (this.openSetEnabled) {
            try {
                this.embedding = new ObjectEmbedding();
                await this.embedding.load();

                this.knownGallery = new KnownObjectGallery();
                await this.knownGallery.load();

                debugLogger.log(`[오픈셋] 준비 완료, 갤러리 항목=${this.knownGallery.entries.length}개`);
            } catch (err) {
                console.error('오픈셋 인식 초기화 실패:', err);
                debugLogger.log(`[오픈셋] 초기화 실패, 비활성화: ${err}`);
                this.embedding = null;
                this.knownGallery = null;
            }
        }
    }

    async setupCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment', // 후면 카메라 우선
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });

            this.video.srcObject = stream;

            return new Promise((resolve) => {
                this.video.onloadedmetadata = () => {
                    this.video.play();
                    this.canvas.width = this.video.videoWidth;
                    this.canvas.height = this.video.videoHeight;
                    resolve();
                };
            });
        } catch (error) {
            console.error('카메라 설정 실패:', error);
            throw error;
        }
    }

    async start() {
        this.isDetecting = true;
        this.lastStage2Time = 0;
        this._perfWindowStart = performance.now();
        this._lastGateSampleTime = 0;
        this._lastGateResult = { looming: false, urgency: 0, tau: Infinity };
        this.motionGate?.reset();
        this._lastPoleSampleTime = 0;
        this._lastPoleResult = { detected: false, bbox: null };
        this.poleGate?.reset();
        this.tracker.reset();
        this.loop();
    }

    stop() {
        this.isDetecting = false;

        // 비디오 스트림 중지
        if (this.video && this.video.srcObject) {
            const stream = this.video.srcObject;
            const tracks = stream.getTracks();
            tracks.forEach(track => track.stop());
            this.video.srcObject = null;
        }

        // 캔버스 클리어
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    // 항상 켜져 있는 루프: 1단계(모션 게이트)는 매 프레임 실행,
    // 2단계(COCO-SSD)는 조건이 맞을 때만 별도로 트리거한다.
    loop() {
        if (!this.isDetecting) return;
        this.tick();
        requestAnimationFrame(() => this.loop());
    }

    tick() {
        const now = performance.now();
        this._perfStage1Count++;

        // 1단계: class-agnostic 확대율(looming) 계산.
        // 리드백 비용 때문에 매 rAF가 아니라 motionGateSampleIntervalMs 주기로 샘플링하고,
        // 그 사이 프레임에는 마지막 결과를 재사용한다 (stage1은 여전히 stage2 기본
        // 주기보다 훨씬 촘촘하게 샘플링되므로 "상시 켜짐" 취지는 유지된다).
        let gate = this._lastGateResult;
        if (this.motionGateEnabled) {
            if (now - this._lastGateSampleTime >= this.motionGateSampleIntervalMs) {
                gate = this.motionGate.update();
                this._lastGateResult = gate;
                this._lastGateSampleTime = now;
            }
        } else {
            gate = { looming: false, urgency: 0, tau: Infinity };
        }

        // 기둥 게이트 샘플링 — motionGate와 별개 주기, looming과 무관하게 항상 시도.
        // (전봇대/기둥은 접근 중이 아니라 스쳐 지나가거나 가만히 서 있어도 위험하다)
        if (this.poleGateEnabled && this.poleGate) {
            if (now - this._lastPoleSampleTime >= this.poleGateSampleIntervalMs) {
                this._lastPoleResult = this.poleGate.update();
                this._lastPoleSampleTime = now;
            }
        }

        // 2단계 실행 여부 결정.
        // dueByBaseInterval: 기본 주기 — 모션 게이트와 무관하게 항상 보장됨(안전 원칙).
        // dueByLooming: 1단계가 급격한 확대를 감지했을 때만 주기를 앞당김. 이 조건은
        // 절대로 dueByBaseInterval을 늦추거나 생략시키는 방향으로 쓰이지 않는다.
        const elapsedSinceStage2 = now - this.lastStage2Time;
        const dueByBaseInterval = elapsedSinceStage2 >= this.stage2BaseIntervalMs;
        const dueByLooming = gate.looming && elapsedSinceStage2 >= this.stage2MinGapOnLoomingMs;

        if ((dueByBaseInterval || dueByLooming) && !this._stage2Running) {
            this.lastStage2Time = now;
            this._perfStage2Count++;
            this._stage2Running = true;
            this.runStage2(gate).finally(() => {
                this._stage2Running = false;
            });
        }

        this.reportPerf(now);
    }

    // 2단계: COCO-SSD 분류 + 기존 위협도 로직(그대로 재사용)
    async runStage2(gate) {
        try {
            let predictions = await this.model.detect(this.video);

            // Phase 2: 저confidence 박스만 임베딩으로 재확인 (open-set)
            if (this.embedding && this.knownGallery) {
                predictions = await this.resolveOpenSet(predictions);
            }

            // 신호등 색 판정 (원래 특허 구상의 "빨간불 경고/초록불 안내")
            this.classifyTrafficLights(predictions);

            // 일반 장애물 폴백 — 벽/기둥/전봇대처럼 COCO-SSD가 애초에 모르는
            // 물체는 박스 자체가 안 생겨서 모션게이트가 확대를 감지해도 경고로
            // 이어지지 못하는 실제 안전 공백이 있었다. 모션게이트가 확대를
            // 감지했는데 그 위치를 설명하는 COCO-SSD 박스가 하나도 없으면,
            // 모션게이트 자신이 감지한 영역을 "장애물"로 합성해 넣는다.
            //
            // 실기기 실측(2026-09-18)에서 7일간 위험감지 3619회 중 obstacle이 1268회로
            // 과도했음이 확인됨. gate.looming(2단계를 앞당기는 용도, 기준이 느슨해도
            // 괜찮음 — 틀려도 COCO-SSD 한 번 더 도는 비용뿐)과 달리, 사용자에게 직접
            // 경고를 노출하는 이 분기는 더 엄격한 기준(urgency)을 따로 둔다.
            const obstacleUrgencyThreshold = 0.5;
            if (gate.looming && gate.urgency >= obstacleUrgencyThreshold && gate.hotRegionBbox) {
                const explained = predictions.some((p) => this.bboxOverlaps(p.bbox, gate.hotRegionBbox));
                if (!explained) {
                    predictions.push({
                        class: 'obstacle',
                        score: Math.max(0.5, gate.urgency),
                        bbox: gate.hotRegionBbox
                    });
                    debugLogger.log(`[모션게이트] COCO-SSD가 못 잡은 정면 장애물 감지 (urgency=${gate.urgency.toFixed(2)})`);
                }
            }

            // 기둥 게이트 — 전봇대/기둥 등 길고 가는 수직 구조물. looming(접근)과 무관하게
            // 항상 확인하며, COCO-SSD가 이미 그 자리를 설명하고 있으면 중복 추가하지 않는다.
            if (this._lastPoleResult.detected && this._lastPoleResult.bbox) {
                const poleBbox = this._lastPoleResult.bbox;
                const explained = predictions.some((p) => this.bboxOverlaps(p.bbox, poleBbox));
                if (!explained) {
                    predictions.push({
                        class: 'pole',
                        score: 0.55,
                        bbox: poleBbox
                    });
                    debugLogger.log('[기둥게이트] 수직 구조물(전봇대/기둥 추정) 감지');
                }
            }

            // 객체 추적 — 차량/오토바이/자전거 진행방향 화살표용 이동벡터 계산
            // (§ObjectTracker). 매 사이클 독립적인 COCO-SSD 박스에 프레임 간
            // 정체성을 붙여준다.
            predictions = this.tracker.update(predictions);

            // 캔버스 클리어
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            // 위협 분석 (기존 로직 재사용)
            const threats = this.analyzeThreats(predictions);

            // 시각화
            this.visualizePredictions(predictions, threats);

            if (gate.looming) {
                debugLogger.log(`[모션게이트] looming으로 조기 검사 (tau=${gate.tau.toFixed(2)}s, urgency=${gate.urgency.toFixed(2)})`);
            }

            // 콜백 호출
            if (this.onDetection && threats.length > 0) {
                this.onDetection(threats);
            }

        } catch (error) {
            console.error('탐지 오류:', error);
        }
    }

    // Phase 2: COCO-SSD 저confidence 박스만 임베딩으로 재확인 (open-set 인식)
    async resolveOpenSet(predictions) {
        const candidates = predictions
            .map((p, index) => ({ p, index }))
            // person은 갤러리에 일부러 넣지 않았으므로(프라이버시) 재확인 대상에서도 제외 —
            // COCO-SSD 자체 판정을 그대로 신뢰한다. 안 그러면 confidence가 애매한
            // 사람 탐지가 전부 "미지 객체"로 바뀌어 음성 메시지만 불필요하게 부정확해진다.
            // 그 외엔 저confidence이거나, confidence와 무관하게 도메인 밖 클래스(예: elephant,
            // remote)면 재확인 대상 — 후자는 "확신에 찬 오분류"를 잡기 위한 것.
            .filter(({ p }) => p.class !== 'person' &&
                (p.score < this.lowConfidenceThreshold || !this.domainRelevantClasses.has(p.class)))
            .slice(0, this.maxEmbeddingChecksPerCycle);

        for (const { p, index } of candidates) {
            try {
                const crop = this.cropVideoRegion(p.bbox, 224);
                const embedding = await this.embedding.embed(crop);
                const { entry, similarity } = this.knownGallery.match(embedding);

                if (entry && similarity >= this.knownSimilarityThreshold) {
                    debugLogger.log(`[오픈셋] "${p.class}"(${p.score.toFixed(2)}) → "${entry.category}"로 재판정 (유사도=${similarity.toFixed(2)})`);
                    predictions[index] = { ...p, class: entry.category };
                } else {
                    debugLogger.log(`[오픈셋] "${p.class}"(${p.score.toFixed(2)}) → 미지 객체 (최고유사도=${similarity.toFixed(2)})`);
                    predictions[index] = { ...p, class: 'unknown' };
                    this.maybeQueueForLabeling(crop, p);
                }
            } catch (err) {
                debugLogger.log(`[오픈셋] 재확인 실패: ${err}`);
            }
        }

        return predictions;
    }

    // 두 bbox([x,y,w,h])가 겹치는지 (단순 AABB 교차 판정)
    bboxOverlaps(a, b) {
        const [ax, ay, aw, ah] = a;
        const [bx, by, bw, bh] = b;
        return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

    // 신호등 색 판정 — COCO-SSD가 'traffic light'로 찾은 박스마다 크롭해서
    // 켜진 램프 색을 분석한다. 임베딩 모델 없이 픽셀 분석만 쓰므로 매우 저비용,
    // 사이클당 개수 제한 없이 매번 돌려도 부담이 적다.
    classifyTrafficLights(predictions) {
        predictions.forEach((pred) => {
            if (pred.class !== 'traffic light') return;

            try {
                const canvas = this.cropForColorAnalysis(pred.bbox);
                const ctx = canvas.getContext('2d');
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                // 원본(비디오상) bbox 픽셀 면적을 같이 넘겨서, 멀리 있어 원래도 작은
                // 신호등은 판정 기준을 조금 더 관대하게 적용한다(§classifyTrafficLightColor).
                const [, , bw, bh] = pred.bbox;
                const { color, confidence } = classifyTrafficLightColor(imageData, { sourceArea: bw * bh });
                pred.trafficLightColor = color;
                pred.trafficLightConfidence = confidence;
            } catch (err) {
                pred.trafficLightColor = null;
            }
        });
    }

    cropForColorAnalysis(bbox) {
        const [x, y, w, h] = bbox;
        if (!this._trafficLightCanvas) {
            this._trafficLightCanvas = document.createElement('canvas');
        }
        const size = 48;
        this._trafficLightCanvas.width = size;
        this._trafficLightCanvas.height = size;
        const ctx = this._trafficLightCanvas.getContext('2d');
        // 먼 신호등은 원본 bbox가 몇 픽셀 안 된다 — 기본(블러 보간) 스케일링은 그 몇 픽셀의
        // 램프 색을 주변 검은 하우징과 섞어버려 색 판정을 어렵게 만든다. nearest-neighbor로
        // 확대해 원래 색을 (뭉개지 않고) 블록 형태로라도 보존한다.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.video, x, y, Math.max(1, w), Math.max(1, h), 0, 0, size, size);
        return this._trafficLightCanvas;
    }

    // 비디오의 bbox 영역을 정사각형으로 크롭 (임베딩 입력용 + 라벨링 큐 업로드용 공용)
    cropVideoRegion(bbox, size) {
        const [x, y, w, h] = bbox;
        if (!this._cropCanvas) {
            this._cropCanvas = document.createElement('canvas');
        }
        this._cropCanvas.width = size;
        this._cropCanvas.height = size;
        const ctx = this._cropCanvas.getContext('2d');
        ctx.drawImage(this.video, x, y, w, h, 0, 0, size, size);
        return this._cropCanvas;
    }

    // 미지 객체 라벨링 큐 (docs/phase2-design.md §등록 경로).
    // 기본값 OFF, 사용자가 설정에서 명시적으로 옵트인해야 동작한다.
    // 자동 서버 업로드는 의도적으로 만들지 않는다 — 공개 레포 JS에 쓰기 토큰을
    // 넣으면 누구나 추출해 악용할 수 있어서다. 대신 로컬 큐에 쌓아두고, 디버그
    // 패널의 "미지 객체 내보내기"로 ZIP 다운로드 → 사용자가 GitHub Issue에
    // 수동으로 첨부하는 흐름을 쓴다 (src/utils/unknownObjectExporter.js).
    maybeQueueForLabeling(cropCanvas, pred) {
        const optedIn = localStorage.getItem('unknownObjectContribution') === 'true';
        if (!optedIn) return;

        try {
            // 실측(2026-09-16/18)에서 사용자가 보내준 ZIP 대부분이 보행 중 손떨림으로
            // 블러가 심해 갤러리 확장용으로 못 쓸 정도였다. 흐린 크롭은 애초에 큐에
            // 넣지 않는다 — 적게 쌓여도 쓸모 있는 게 낫다.
            const ctx = cropCanvas.getContext('2d');
            const imageData = ctx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
            const sharpness = estimateSharpness(imageData);
            if (sharpness < this.minCropSharpness) {
                debugLogger.log(`[오픈셋] 크롭이 흐려서 큐에서 제외 (선명도=${sharpness.toFixed(0)})`);
                return;
            }

            const dataUrl = cropCanvas.toDataURL('image/jpeg', 0.6);
            const queue = JSON.parse(localStorage.getItem('unknownObjectQueue') || '[]');
            queue.push({
                dataUrl,
                originalClass: pred.class,
                score: pred.score,
                timestamp: Date.now()
            });
            // 로컬 큐 크기 제한. 224px JPEG(q=0.6) data URL 1개 ≈ 15~27KB, 150개면 최대 ~4MB로
            // localStorage 출처당 한도(보통 5~10MB) 안에 여유 있게 들어온다. 기존 20개는 공원
            // 산책처럼 긴 세션에서 금방 밀려나 초반 관찰이 사라진다는 사용자 피드백(2026-09-18)으로 상향.
            while (queue.length > 150) queue.shift();
            localStorage.setItem('unknownObjectQueue', JSON.stringify(queue));
            debugLogger.log(`[오픈셋] 미지 객체 로컬 큐 저장 (${queue.length}개 대기, 디버그 패널에서 내보내기 가능)`);
        } catch (err) {
            debugLogger.log(`[오픈셋] 큐 저장 실패: ${err}`);
        }
    }

    // Phase 1 실측 비교용: 모션 게이트 on/off 런타임 토글
    toggleMotionGate() {
        this.motionGateEnabled = !this.motionGateEnabled;
        debugLogger.log(`[모션게이트] ${this.motionGateEnabled ? 'ON' : 'OFF'}으로 전환`);
        return this.motionGateEnabled;
    }

    reportPerf(now) {
        if (now - this._perfWindowStart < 2000) return;

        const seconds = (now - this._perfWindowStart) / 1000;
        const stage1Fps = (this._perfStage1Count / seconds).toFixed(1);
        const stage2Rate = (this._perfStage2Count / seconds).toFixed(2);
        debugLogger.log(`[성능] stage1=${stage1Fps}fps, stage2=${stage2Rate}회/s, 게이트=${this.motionGateEnabled ? 'ON' : 'OFF'}`);

        this._perfStage1Count = 0;
        this._perfStage2Count = 0;
        this._perfWindowStart = now;
    }

    analyzeThreats(predictions) {
        const threats = [];
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;

        predictions.forEach(pred => {
            const [x, y, width, height] = pred.bbox;

            // 거리 추정 (바운딩 박스 크기 기반)
            const distance = this.estimateDistance(pred.bbox, pred.class);

            // 위치 기반 위험도
            const objCenterX = x + width / 2;
            const objCenterY = y + height / 2;
            const distFromCenter = Math.sqrt(
                Math.pow(objCenterX - centerX, 2) +
                Math.pow(objCenterY - centerY, 2)
            );
            const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);
            const positionWeight = 1 - (distFromCenter / maxDist);

            // 방향 판단
            let direction = '';
            if (objCenterX < centerX * 0.7) direction = '왼쪽';
            else if (objCenterX > centerX * 1.3) direction = '오른쪽';
            else if (objCenterY < centerY * 0.7) direction = '위';
            else if (objCenterY > centerY * 1.3) direction = '아래';
            else direction = '정면';

            // 종합 위험도 계산
            let baseThreat = this.threatLevels[pred.class] || 0.1;
            // 신호등은 색에 따라 위험도가 완전히 달라진다 — 빨간불(건너면 위험) vs
            // 초록불(안내용, 저위험). 원래 특허 구상의 "빨간불 경고/초록불 안내" 반영.
            if (pred.class === 'traffic light' && pred.trafficLightColor) {
                baseThreat = { red: 0.75, yellow: 0.45, green: 0.15 }[pred.trafficLightColor] ?? baseThreat;
            }
            const distanceThreat = Math.max(0, 1 - (distance / 10));
            const threatLevel =
                (baseThreat * 0.4) +
                (distanceThreat * 0.4) +
                (positionWeight * 0.1) +
                (pred.score * 0.1);

            threats.push({
                class: pred.class,
                level: threatLevel,
                distance: distance,
                direction: direction,
                bbox: pred.bbox,
                confidence: pred.score,
                trafficLightColor: pred.trafficLightColor || null,
                // 진행방향 화살표용 (§ObjectTracker) — 차량/오토바이/자전거만 의미 있음
                motionVector: pred.motionVector || null,
                sizeChangeRate: pred.sizeChangeRate ?? null
            });
        });

        // 위험도 순으로 정렬
        return threats.sort((a, b) => b.level - a.level);
    }

    estimateDistance(bbox, objectClass) {
        const [x, y, width, height] = bbox;

        // 표준 객체 높이 (미터)
        const standardHeights = {
            'person': 1.7,
            'car': 1.5,
            'bicycle': 1.0,
            'motorcycle': 1.2,
            'bus': 3.0,
            'truck': 3.5,
            'traffic light': 3.0,
            'stop sign': 2.0
        };

        const stdHeight = standardHeights[objectClass] || 1.5;
        const focalLength = 800; // 카메라 초점거리 (픽셀, 조정 필요)

        // 거리 = (실제높이 × 초점거리) / 픽셀높이
        const distance = (stdHeight * focalLength) / height;
        return Math.min(distance, 50); // 최대 50m
    }

    // 실제 객체(바운딩박스/원본 영상 크롭)를 그대로 보여주지 않고 이모지로만
    // 표현한다 — 제품 방향(§ AI_개발위임_브리프.md 대화 결정사항). 투명도는
    // 설정 화면의 슬라이더(emojiOpacity, localStorage)로 사용자가 조절한다.
    getEmojiOpacity() {
        const raw = localStorage.getItem('emojiOpacity');
        const val = raw === null ? NaN : parseInt(raw, 10);
        if (Number.isNaN(val)) return 0.85;
        return Math.min(1, Math.max(0.1, val / 100));
    }

    // 거리에 따른 투명도 배율. 가까우면(2m 이하) 1.0(선명), 멀면(20m 이상) 바닥값까지
    // 점점 흐려진다 — 완전히 안 보이게는 하지 않는다("뭔가 있다"는 힌트는 유지).
    // 사용자 요청(2026-09-19): "멀리 있을 때는 흐릿하게, 가까이 올수록 진하게".
    getDistanceOpacityFactor(distance) {
        if (distance === undefined || distance === null) return 1;
        const near = 2;
        const far = 20;
        const floor = 0.2;
        if (distance <= near) return 1;
        if (distance >= far) return floor;
        const t = (distance - near) / (far - near);
        return 1 - t * (1 - floor);
    }

    visualizePredictions(predictions, threats) {
        // 위협 맵 생성 (빠른 조회용)
        const threatMap = new Map();
        threats.forEach(t => {
            const key = `${t.class}-${t.bbox.join(',')}`;
            threatMap.set(key, t);
        });

        const baseOpacity = this.getEmojiOpacity();

        predictions.forEach(pred => {
            const [x, y, width, height] = pred.bbox;
            const key = `${pred.class}-${pred.bbox.join(',')}`;
            const threat = threatMap.get(key);

            let icon = this.iconMap[pred.class] || '❓';
            // 신호등은 실제 켜진 색을 그대로 이모지로 표현 (판정 못 하면 기본 🚦 유지)
            if (pred.class === 'traffic light' && pred.trafficLightColor) {
                icon = { red: '🔴', yellow: '🟡', green: '🟢' }[pred.trafficLightColor] || icon;
            }

            // 위험도에 따른 색상
            let color = '#4CAF50'; // 녹색 (안전)
            if (threat) {
                if (threat.level > 0.7) color = '#f44336'; // 빨강 (위험)
                else if (threat.level > 0.4) color = '#ff9800'; // 주황 (주의)
            }

            const centerX = x + width / 2;
            const centerY = y + height / 2;

            // 객체(바운딩박스)가 클수록(=가까울수록) 이모지도 크게 — 거리를
            // 직관적으로 느끼게 하는 신호
            const fontSize = Math.min(140, Math.max(28, height * 0.55));
            const radius = fontSize * 0.65;

            // 이 물체까지의 거리로 투명도를 한 번 더 배율 조정
            const opacity = baseOpacity * this.getDistanceOpacityFactor(threat?.distance);

            // 위협도 색상 글로우 — 박스 대신 은은한 원으로 위험도만 표시
            this.ctx.save();
            this.ctx.globalAlpha = opacity * 0.35;
            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();

            // 이모지
            this.ctx.save();
            this.ctx.globalAlpha = opacity;
            this.ctx.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(icon, centerX, centerY);
            this.ctx.restore();

            // 거리 표시
            if (threat) {
                this.ctx.save();
                this.ctx.globalAlpha = opacity;
                this.ctx.font = '14px Arial';
                this.ctx.fillStyle = color;
                this.ctx.textAlign = 'center';
                this.ctx.fillText(`${threat.distance.toFixed(1)}m`, centerX, centerY + radius + 16);
                this.ctx.restore();
            }

            // 진행방향 화살표 — 차량/오토바이/자전거는 실제 이동방향(추적된 벡터)을
            // 보여준다(사용자 요청 2026-09-19). 다가오면 아래(나를 향해), 멀어지면
            // 위(나에게서 멀어지는 방향)로, 좌우 이동은 그대로 반영. 추적 이력이
            // 부족하거나(막 탐지됨) 거의 안 움직이면 일반 위치 화살표로 대체.
            if (this.trackedClasses.has(pred.class) && threat?.motionVector) {
                const { dx } = threat.motionVector;
                const dy = threat.sizeChangeRate ?? 0;
                const magnitude = Math.hypot(dx, dy);
                if (magnitude > 15) { // px/s — 노이즈성 미세 흔들림 제외, 실측 후 조정 필요
                    const angle = Math.atan2(dx, -dy);
                    this.ctx.globalAlpha = opacity;
                    this.drawTravelArrow(centerX, centerY - radius - 20, angle, color);
                    this.ctx.globalAlpha = 1;
                } else if (threat.direction && threat.direction !== '정면') {
                    this.ctx.globalAlpha = opacity;
                    this.drawDirectionArrow(centerX, centerY - radius - 20, threat.direction, color);
                    this.ctx.globalAlpha = 1;
                }
            } else if (threat && threat.direction && threat.direction !== '정면') {
                this.ctx.globalAlpha = opacity;
                this.drawDirectionArrow(centerX, centerY - radius - 20, threat.direction, color);
                this.ctx.globalAlpha = 1;
            }
        });
    }

    drawDirectionArrow(x, y, direction, color) {
        this.ctx.save();
        this.ctx.translate(x, y);

        // 방향에 따른 회전
        let rotation = 0;
        switch (direction) {
            case '왼쪽': rotation = -Math.PI / 2; break;
            case '오른쪽': rotation = Math.PI / 2; break;
            case '위': rotation = 0; break;
            case '아래': rotation = Math.PI; break;
        }
        this.ctx.rotate(rotation);

        // 화살표 그리기
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.moveTo(0, -20);
        this.ctx.lineTo(-10, -5);
        this.ctx.lineTo(10, -5);
        this.ctx.closePath();
        this.ctx.fill();

        this.ctx.restore();
    }

    // 진행방향 화살표 — drawDirectionArrow(4방향 고정)와 달리 임의 각도(라디안)로
    // 회전한다. angle=0이 "위"를 가리키는 기준.
    drawTravelArrow(x, y, angleRad, color) {
        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.rotate(angleRad);

        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.moveTo(0, -20);
        this.ctx.lineTo(-10, -5);
        this.ctx.lineTo(10, -5);
        this.ctx.closePath();
        this.ctx.fill();

        this.ctx.restore();
    }
}