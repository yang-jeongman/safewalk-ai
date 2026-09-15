// 객체 탐지 관리 모듈
import { MotionGate } from './motionGate.js';
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

        // 위험 객체 정의
        this.threatLevels = {
            'car': 0.9,
            'bus': 0.9,
            'truck': 0.9,
            'motorcycle': 0.8,
            'bicycle': 0.7,
            'person': 0.5,
            'traffic light': 0.4,
            'stop sign': 0.4
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
            'stop sign': '🛑'
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

        // COCO-SSD 모델 로드
        console.log('AI 모델 로딩 중...');
        this.model = await cocoSsd.load();
        console.log('AI 모델 로드 완료');
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
        this.motionGate?.reset();
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

        // 1단계: class-agnostic 확대율(looming) 계산 — 저비용, 매 프레임
        const gate = this.motionGateEnabled
            ? this.motionGate.update()
            : { looming: false, urgency: 0, tau: Infinity };

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
            const predictions = await this.model.detect(this.video);

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
            const baseThreat = this.threatLevels[pred.class] || 0.1;
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
                confidence: pred.score
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

    visualizePredictions(predictions, threats) {
        // 위협 맵 생성 (빠른 조회용)
        const threatMap = new Map();
        threats.forEach(t => {
            const key = `${t.class}-${t.bbox.join(',')}`;
            threatMap.set(key, t);
        });

        predictions.forEach(pred => {
            const [x, y, width, height] = pred.bbox;
            const key = `${pred.class}-${pred.bbox.join(',')}`;
            const threat = threatMap.get(key);

            // 아이콘 선택
            const icon = this.iconMap[pred.class] || '❓';

            // 위험도에 따른 색상
            let color = '#4CAF50'; // 녹색 (안전)
            if (threat) {
                if (threat.level > 0.7) color = '#f44336'; // 빨강 (위험)
                else if (threat.level > 0.4) color = '#ff9800'; // 주황 (주의)
            }

            // 바운딩 박스 그리기
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 3;
            this.ctx.strokeRect(x, y, width, height);

            // 배경 박스
            this.ctx.fillStyle = color;
            this.ctx.globalAlpha = 0.2;
            this.ctx.fillRect(x, y, width, height);
            this.ctx.globalAlpha = 1;

            // 라벨 배경
            const label = `${icon} ${pred.class}`;
            const labelWidth = this.ctx.measureText(label).width + 20;
            this.ctx.fillStyle = color;
            this.ctx.fillRect(x, y - 30, labelWidth, 30);

            // 라벨 텍스트
            this.ctx.fillStyle = 'white';
            this.ctx.font = '16px Arial';
            this.ctx.fillText(label, x + 10, y - 8);

            // 거리 표시
            if (threat) {
                const distText = `${threat.distance.toFixed(1)}m`;
                this.ctx.font = '14px Arial';
                this.ctx.fillStyle = color;
                this.ctx.fillText(distText, x + 10, y + height - 10);
            }

            // 방향 화살표
            if (threat && threat.direction && threat.direction !== '정면') {
                const centerX = x + width / 2;
                const centerY = y + height / 2;
                this.drawDirectionArrow(centerX, centerY, threat.direction, color);
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
}