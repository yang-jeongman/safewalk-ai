// 번호판 조회 모드 — 카메라 + 수동 조준 캡처.
// 보행 안전용 DetectionManager(motionGate/poleGate/추적기가 서로 촘촘히 얽혀
// 이미 실기기에서 튜닝된 상태)는 건드리지 않고, 완전히 별도의 가벼운 엔진으로
// 분리한다 — 이 모드의 버그가 보행 안전 기능에 영향을 줄 수 없게 하기 위함.
//
// 상호작용 방식 변경 이력(2026-09-19): 원래는 COCO-SSD로 차량을 자동 감지해
// 걸으면서 매 차량마다 자동으로 번호판을 크롭·인식했다. 실측(정차 차량 30장,
// 실제 도보 854장)에서 "차량 박스 하단 40%"라는 고정 비율 크롭이 실제 도보 중
// 다양한 각도·거리에서는 번호판을 자주 놓친다는 게 드러나, 자동 감지를 걷어내고
// 실제 CCTV/스캐너 앱들처럼 "사용자가 직접 프레임에 번호판을 맞추고 확인 버튼을
// 누르는" 방식으로 바꿨다.
//
// 인식 엔진 교체(2026-09-20): Tesseract.js를 AI Hub 공식 번호판 데이터셋 300장으로
// 대규모 검증한 결과 정확 일치 2.7%에 그쳤다 — 이진화 등 전처리를 아무리 다듬어도
// 사람 눈엔 선명한 이미지조차 잘 못 읽었고, 특히 가운데 한글 글자에서 거의 항상
// 틀리거나 통째로 빠졌다. 촬영 조건이 아니라 범용 OCR 자체가 한국 번호판 글꼴에
// 안 맞는다는 뜻이라 판단, 번호판 전용으로 학습된 오픈소스 모델(VRPDetectorKOR,
// HK416, MIT License, YOLOv8 기반)로 위치 검출+글자 인식 둘 다 교체했다 —
// onnxPlateDetector.js / onnxCharacterReader.js 참고. 이 모델도 원작자 본인이
// "한글 인식률이 높지 않다"고 밝힌 만큼 완벽을 보장하진 않으며, 실기기 검증 필요.
import { findMatch, normalizePlate } from './plateMatcher.js';
import { classifyPlateColor } from './plateColor.js';
import { estimateSharpness } from '../detection/sharpness.js';
import { OnnxPlateDetector } from './onnxPlateDetector.js';
import { OnnxCharacterReader } from './onnxCharacterReader.js';
import { debugLogger } from '../utils/debugLogger.js';

export class PlateScanManager {
    constructor() {
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.plateDetector = null;
        this.characterReader = null;

        this.isActive = false; // 카메라가 켜져 가이드 프레임을 그리고 있는지
        this._animFrameId = null;
        this._capturing = false;
        this._locating = false; // ONNX 위치 검출이 비동기라 겹쳐 돌지 않게 막는 플래그

        // 가이드 프레임 — 번호판 근사 비율(신형 8자리 단일행 기준 약 2.8:1)로 화면
        // 중앙에 고정 표시. 정확한 크기가 아니라 "이 안에 번호판을 맞추라"는 조준
        // 보조선일 뿐이라 여유를 두고 약간 넓게 잡았다.
        this.guideAspectRatio = 2.8;
        this.guideWidthFraction = 0.82;

        // 추적된 프레임 폭이 이 비율보다 작으면(=번호판이 화면에서 차지하는 실제
        // 픽셀 수가 작으면) "찾았지만 너무 멀다"로 취급한다. cropGuideRegion()의
        // 출력 폭(400px)을 감안한 값 — 실기기 기준 보정 전 시작값.
        this.minTrackedWidthFraction = 0.3;

        // 실시간 번호판 위치 추적 — 아이폰 QR 촬영처럼 프레임이 번호판을 "따라가게"
        // 해달라는 요청(2026-09-19)에 대응. plateLocator.js는 OpenCV 없이 순수
        // Canvas 2D로 짠 휴리스틱(에지 밀도 기반)이라 QR 검출만큼 정확하다는 보장은
        // 없다 — 그래서 최종 캡처는 여전히 사용자가 직접 확인하고 누르게 남겨둔다.
        // 못 찾으면 서서히 기본 중앙 프레임으로 되돌아온다(어색하게 멈춰있지 않도록).
        this.trackedRect = null; // 현재 화면에 보이는(스무딩된) 가이드 프레임, null=기본값
        this._lastFoundTime = 0;
        this._locateTimer = null;
        this.locateIntervalMs = 300; // 매 프레임 돌리기엔 무거워서 샘플링
        this._pendingCandidate = null; // 위치 연속성 확인용 (poleGate.js와 같은 패턴)
        this._pendingStreak = 0;

        // 흐린 사진 경고용 기준선 — 아직 번호판 크롭 기준으로 실측 보정된 적 없는
        // 시작값(미지 객체 큐의 값과 동일 계열 방식만 재사용). 자동 스캔 때와 달리
        // 여기선 결과를 무조건 보여주고 "흐릴 수 있음"만 경고한다(차단하지 않음) —
        // 사용자가 직접 조준한 캡처라 결과를 숨기는 것보다 보여주고 판단을 맡기는
        // 게 낫다고 판단.
        this.minPlateCropSharpness = 60;
        this._currentSharpness = 0; // 실시간 추적 중 매 샘플마다 갱신(초록불 조건에 사용)

        this.plateList = []; // dataManager.getPlateList()에서 로드된 정규화된 목록
        this.onMatch = null; // (match, cropDataUrl) => void — 매칭된 건만 호출됨
        this.onStatus = null; // (text) => void — 화면 상태 텍스트 업데이트용

        // 정확도 테스트 로그용 — 매칭 여부와 무관하게 캡처마다 호출됨. app.js가
        // 옵트인 설정을 보고 실제 기록 여부를 결정한다.
        this.onRecognized = null; // ({ text, colorLabel, cropDataUrl }) => void

        // 캡처 직후 화면에 "인식됨: XXX" 즉시 피드백을 주기 위한 콜백 — 매칭 여부와
        // 무관하게, 그리고 저장 여부와도 무관하게 매 캡처마다 호출된다.
        this.onCaptureResult = null; // ({ text, rawText, match, colorLabel, sharpness, cropDataUrl }) => void
    }

    setPlateList(list) {
        this.plateList = list;
    }

    async init() {
        this.video = document.getElementById('plateVideoElement');
        this.canvas = document.getElementById('plateCanvasOverlay');
        this.ctx = this.canvas.getContext('2d');

        await this.setupCamera();

        debugLogger.log('[번호판조회] 위치 검출 모델 로딩 중...');
        this.plateDetector = new OnnxPlateDetector();
        await this.plateDetector.load();

        debugLogger.log('[번호판조회] 글자 인식 모델 로딩 중...');
        this.characterReader = new OnnxCharacterReader();
        await this.characterReader.load();

        debugLogger.log('[번호판조회] 초기화 완료');
    }

    async setupCamera() {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
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
    }

    start() {
        this.isActive = true;
        this.trackedRect = null;
        this._lastFoundTime = 0;
        this._pendingCandidate = null;
        this._pendingStreak = 0;
        const animate = () => {
            if (!this.isActive) return;
            this.drawGuideFrame();
            this._animFrameId = requestAnimationFrame(animate);
        };
        this._animFrameId = requestAnimationFrame(animate);

        this._locateTimer = setInterval(() => {
            if (this._capturing || this._locating) return; // 캡처 중/추론 중이면 건너뛰기
            this.updateTrackedRect();
        }, this.locateIntervalMs);
    }

    stop() {
        this.isActive = false;
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }
        if (this._locateTimer) {
            clearInterval(this._locateTimer);
            this._locateTimer = null;
        }
        this.trackedRect = null;
        if (this.video && this.video.srcObject) {
            this.video.srcObject.getTracks().forEach(t => t.stop());
            this.video.srcObject = null;
        }
        if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.plateDetector?.dispose();
        this.characterReader?.dispose();
    }

    // 매 locateIntervalMs마다 호출 — plateLocator로 후보를 찾으면 그쪽으로 부드럽게
    // 이동(스무딩), 한동안 못 찾으면 기본 중앙 프레임으로 서서히 복귀한다.
    //
    // 실측(2026-09-19, 실기기) 2차: "스크린샷과 달리 프레임이 붙는 시간은 잠깐이고
    // 계속 다른 위치를 찾아 다닌다" — 1차 수정(새 후보끼리 2연속 일치해야 인정)은
    // 절반만 고쳤다. 문제는 그 비교 대상이 "직전 후보"였지 "지금 추적 중인 자리"가
    // 아니었다는 점이다: 이미 번호판에 잘 붙어 있어도, 보닛 무늬 같은 엉뚱한 후보가
    // 우연히 2번 연속 나오면 바로 거기로 끌려갔다 — 한 번 자리 잡은 추적에 "관성"이
    // 없었다. 그래서 지금 추적 중인 자리 근처에서 또 찾았으면(같은 대상을 계속 보고
    // 있는 것) streak 없이 바로 미세 보정만 하고, 그 자리에서 한동안 못 찾을 때만
    // "새 후보 인수" 절차(2연속 확인)를 거치도록 나눴다.
    async updateTrackedRect() {
        this._locating = true;
        let found;
        try {
            found = await this.plateDetector.detect(this.video);
        } catch (err) {
            debugLogger.log(`[번호판조회] 위치 검출 실패: ${err}`);
            found = null;
        } finally {
            this._locating = false;
        }
        const now = performance.now();

        if (found) {
            const nearCurrentTrack = this.trackedRect &&
                Math.abs(found.x - this.trackedRect.x) < this.trackedRect.w * 0.5 &&
                Math.abs(found.y - this.trackedRect.y) < this.trackedRect.h * 0.5;

            if (nearCurrentTrack) {
                // 이미 잡고 있던 대상을 계속 보고 있음 — 관성 유지, 잡음성 후보에
                // 넘어가지 않도록 "새 후보 인수" 상태도 여기서 리셋한다.
                this._pendingCandidate = null;
                this._pendingStreak = 0;
                this._lastFoundTime = now;
                const alpha = 0.3;
                this.trackedRect = {
                    x: this.trackedRect.x + (found.x - this.trackedRect.x) * alpha,
                    y: this.trackedRect.y + (found.y - this.trackedRect.y) * alpha,
                    w: this.trackedRect.w + (found.w - this.trackedRect.w) * alpha,
                    h: this.trackedRect.h + (found.h - this.trackedRect.h) * alpha
                };
            } else {
                // 지금 추적 중인 곳과 다른(또는 아직 아무것도 안 잡은) 새 위치 —
                // 최소 2번 연속 같은 새 위치로 나와야 "진짜 새 후보"로 인정한다.
                const overlapsPending = this._pendingCandidate &&
                    Math.abs(found.x - this._pendingCandidate.x) < found.w * 0.5 &&
                    Math.abs(found.y - this._pendingCandidate.y) < found.h * 0.5;

                this._pendingStreak = overlapsPending ? (this._pendingStreak + 1) : 1;
                this._pendingCandidate = found;

                if (this._pendingStreak >= 2) {
                    this._lastFoundTime = now;
                    if (!this.trackedRect) {
                        this.trackedRect = { ...found };
                    } else {
                        const alpha = 0.35;
                        this.trackedRect = {
                            x: this.trackedRect.x + (found.x - this.trackedRect.x) * alpha,
                            y: this.trackedRect.y + (found.y - this.trackedRect.y) * alpha,
                            w: this.trackedRect.w + (found.w - this.trackedRect.w) * alpha,
                            h: this.trackedRect.h + (found.h - this.trackedRect.h) * alpha
                        };
                    }
                }
            }
        } else {
            this._pendingCandidate = null;
            this._pendingStreak = 0;

            if (this.trackedRect && now - this._lastFoundTime > 1500) {
                const target = this.getDefaultGuideRect();
                const alpha = 0.12;
                this.trackedRect = {
                    x: this.trackedRect.x + (target.x - this.trackedRect.x) * alpha,
                    y: this.trackedRect.y + (target.y - this.trackedRect.y) * alpha,
                    w: this.trackedRect.w + (target.w - this.trackedRect.w) * alpha,
                    h: this.trackedRect.h + (target.h - this.trackedRect.h) * alpha
                };
                if (Math.abs(this.trackedRect.w - target.w) < 2 && Math.abs(this.trackedRect.x - target.x) < 2) {
                    this.trackedRect = null; // 기본값에 충분히 가까워지면 완전히 리셋
                }
            }
        }

        // 실측(2026-09-19): 위치는 맞았는데도 흔들려서 인식이 안 되는 경우가 반복
        // 보고됨. 캡처 "후"에만 흐림을 알려주면 이미 늦으므로, 매 샘플마다 현재
        // 프레임 영역의 선명도를 같이 재서 "위치+선명도 둘 다 괜찮을 때만" 초록불이
        // 뜨도록 한다(drawGuideFrame 참고) — 손 떨림 중엔 계속 대기 상태로 남는다.
        try {
            const cropCanvas = this.cropGuideRegion();
            const cropCtx = cropCanvas.getContext('2d');
            const imageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
            this._currentSharpness = estimateSharpness(imageData);
        } catch {
            this._currentSharpness = 0;
        }
    }

    // 캔버스는 video와 같은 네이티브 해상도로 맞춰져 있고 둘 다 동일한 CSS
    // object-fit:cover로 표시되므로, 캔버스 네이티브 좌표에서 그린 사각형이 화면에
    // 보이는 위치와 캡처 시 crop할 video 영역이 좌표계가 그대로 일치한다 —
    // 화면 표시 좌표 ↔ 영상 원본 좌표 변환이 따로 필요 없다.
    getDefaultGuideRect() {
        const w = this.canvas.width * this.guideWidthFraction;
        const h = w / this.guideAspectRatio;
        const x = (this.canvas.width - w) / 2;
        const y = (this.canvas.height - h) / 2;
        return { x, y, w, h };
    }

    // 실시간 추적된 위치가 있으면 그걸, 없으면(아직 못 찾았거나 카메라 막 켜짐) 기본
    // 중앙 프레임을 쓴다. drawGuideFrame()과 cropGuideRegion() 둘 다 이걸 통해서만
    // 프레임 위치를 얻으므로, 화면에 보이는 프레임과 실제 캡처되는 영역이 항상 일치한다.
    getGuideRect() {
        return this.trackedRect || this.getDefaultGuideRect();
    }

    // 모서리 브래킷("뷰파인더") 스타일 — QR 스캐너처럼 네 귀퉁이만 그린다.
    drawCornerBrackets(x, y, w, h, color, bracketLen, lineWidth) {
        const ctx = this.ctx;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        const corners = [
            [[x, y + bracketLen], [x, y], [x + bracketLen, y]],
            [[x + w - bracketLen, y], [x + w, y], [x + w, y + bracketLen]],
            [[x, y + h - bracketLen], [x, y + h], [x + bracketLen, y + h]],
            [[x + w - bracketLen, y + h], [x + w, y + h], [x + w, y + h - bracketLen]]
        ];
        for (const pts of corners) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            ctx.lineTo(pts[1][0], pts[1][1]);
            ctx.lineTo(pts[2][0], pts[2][1]);
            ctx.stroke();
        }
    }

    drawGuideFrame() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const { x, y, w, h } = this.getGuideRect();
        const bracketLen = Math.min(w, h) * 0.16;

        // 테두리가 너무 가늘어 안 보인다는 실기기 피드백(2026-09-20) — 안내 문구
        // 폰트 크기와 같은 원인이었다: 캔버스는 카메라 네이티브 해상도(보통
        // 1280px)로 그려지는데 화면엔 훨씬 작은 CSS 크기로 축소 표시되니, 고정
        // 픽셀 두께가 화면에서는 실제로 1px도 안 되게 보인다. displayScale로
        // 환산해 화면상 두께가 기기·해상도와 무관하게 일정하게 나오도록 한다.
        const displayScale = this.canvas.width / (this.canvas.clientWidth || this.canvas.width);

        let color, lineWidth, label;
        if (this._capturing) {
            const pulse = (Math.sin(performance.now() / 150) + 1) / 2;
            color = `rgba(255, 210, 0, ${0.6 + pulse * 0.4})`;
            lineWidth = (3 + pulse * 3) * displayScale;
            label = '인식 중...';
        } else if (this.trackedRect && performance.now() - this._lastFoundTime < 1500
            && this._currentSharpness < this.minPlateCropSharpness) {
            // 위치는 맞았지만 흔들려서 아직 선명하지 않음 — 초록불을 주지 않고
            // 가만히 있으라고 안내한다(실측 2026-09-19: 위치가 맞아도 흔들려서
            // 인식이 반복 실패하는 게 확인돼 추가).
            color = 'rgba(255, 152, 0, 0.9)';
            lineWidth = 4 * displayScale;
            label = '카메라를 고정해주세요 (흔들림)';
        } else if (this.trackedRect && performance.now() - this._lastFoundTime < 1500
            && this.trackedRect.w < this.canvas.width * this.minTrackedWidthFraction) {
            // 위치도 맞고 안 흔들려도, 번호판이 화면에서 차지하는 실제 픽셀 수 자체가
            // 작으면(폰이 멀리 있으면) 400px로 확대할 때 뭉개진다 — "프레임이 붙었다"와
            // "충분히 가까이서 찍었다"는 다른 문제. 실측(2026-09-19): 프레임이 번호판에
            // 잘 붙었는데도 폰이 멀어서 계속 실패한 사례로 확인돼 추가.
            color = 'rgba(0, 224, 255, 0.85)';
            lineWidth = 4 * displayScale;
            label = '번호판을 찾았습니다 — 조금 더 가까이 다가가주세요';
        } else if (this.trackedRect && performance.now() - this._lastFoundTime < 1500) {
            // 번호판으로 추정되는 위치를 프레임이 따라가고 있고, 흔들림도 없고,
            // 충분히 가까운 상태 — QR 스캐너가 코드를 찾아 프레임을 맞추는 것과 같은
            // 피드백(사용자 요청 2026-09-19)
            color = 'rgba(76, 175, 80, 0.9)';
            lineWidth = 4 * displayScale;
            label = '번호판 위치에 맞춰졌습니다 — 확인 후 눌러주세요';
        } else {
            color = 'rgba(0, 224, 255, 0.85)';
            lineWidth = 4 * displayScale;
            // 실측(2026-09-19): 성공/실패를 가른 결정적 차이는 "차가 프레임에
            // 들어왔는가"가 아니라 "번호판 자체가 프레임을 꽉 채웠는가"였다 —
            // 번호판이 작게 찍힌 시도는 전부 실패, 프레임 가득 채운 시도만 성공.
            // 안내 문구를 그에 맞게 더 구체적으로 바꿈.
            label = '번호판이 프레임을 꽉 채우도록 가까이 다가가주세요';
        }

        this.drawCornerBrackets(x, y, w, h, color, bracketLen, lineWidth);
        this.drawGuideLabel(label, x, y, w, h, color);
    }

    // 안내 문구가 너무 작다는 실기기 피드백(2026-09-19) 대응. 캔버스는 화면 CSS
    // 크기가 아니라 카메라 네이티브 해상도(보통 1280px 폭)로 그려지는데, 고정 픽셀
    // 폰트를 쓰면 화면에 표시될 때(CSS로 축소) 실제로는 훨씬 작게 보인다 — 캔버스
    // 내부 해상도 대 실제 표시 크기(clientWidth) 비율로 폰트를 환산해서, 기기·화면
    // 크기와 무관하게 화면상 일정한 글자 크기(약 18px 상당)가 나오게 한다.
    drawGuideLabel(label, x, y, w, h, color) {
        const displayScale = this.canvas.width / (this.canvas.clientWidth || this.canvas.width);
        const fontSize = Math.round(18 * displayScale);
        this.ctx.font = `bold ${fontSize}px sans-serif`;

        const textY = y > fontSize + 14 ? y - 10 : y + h + fontSize + 6;
        const metrics = this.ctx.measureText(label);
        const padding = fontSize * 0.4;

        // 어떤 배경(그릴, 도로 등) 위에서도 읽히도록 반투명 검정 배경을 깐다
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        this.ctx.fillRect(x - padding, textY - fontSize, metrics.width + padding * 2, fontSize + padding);

        this.ctx.fillStyle = color;
        this.ctx.fillText(label, x, textY);
    }

    cropGuideRegion() {
        const { x, y, w, h } = this.getGuideRect();
        const outW = 400;
        const outH = Math.max(1, Math.round(outW * (h / w)));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.video, x, y, w, h, 0, 0, outW, outH);
        return canvas;
    }

    // 사용자가 "번호판 인식" 버튼을 눌렀을 때만 호출된다 — 자동 감지/루프 없음.
    // 글자 인식은 화면에 보이는 가이드 프레임(getGuideRect()) 영역 그대로 ONNX
    // 글자 검출 모델에 넘긴다 — 이진화 등 별도 전처리는 하지 않는다(이 모델은
    // 원색 이미지로 학습됐음, plateOcr.js의 Tesseract 전용 전처리와는 다름).
    async capture() {
        if (this._capturing || !this.characterReader) return null;
        this._capturing = true;
        this.onStatus?.('번호판 인식 중...');
        try {
            const guideRect = this.getGuideRect();
            const cropCanvas = this.cropGuideRegion();
            const cropCtx = cropCanvas.getContext('2d');
            const imageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);

            const colorInfo = classifyPlateColor(imageData);
            const sharpness = estimateSharpness(imageData);
            const cropDataUrl = cropCanvas.toDataURL('image/jpeg', 0.8);

            const rawText = await this.characterReader.read(this.video, guideRect);
            const normalizedText = normalizePlate(rawText);
            const match = findMatch(rawText, this.plateList);

            const result = {
                text: normalizedText,
                rawText: rawText.trim(),
                match,
                colorLabel: colorInfo.label,
                sharpness,
                cropDataUrl
            };

            if (match) {
                match.colorLabel = colorInfo.label;
                debugLogger.log(`[번호판조회] 매칭: "${rawText.trim()}" → ${match.plate} (${match.matchType})`);
                this.onMatch?.(match, cropDataUrl);
            } else {
                debugLogger.log(`[번호판조회] 인식 결과: "${normalizedText || '(비어있음)'}" (매칭 없음, 선명도=${sharpness.toFixed(0)})`);
            }
            this.onRecognized?.({ text: normalizedText, colorLabel: colorInfo.label, cropDataUrl });
            this.onCaptureResult?.(result);
            return result;
        } catch (err) {
            debugLogger.log(`[번호판조회] 인식 실패: ${err}`);
            return null;
        } finally {
            this._capturing = false;
            this.onStatus?.('대기 중');
        }
    }
}
