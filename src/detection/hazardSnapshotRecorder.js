// 위험요소 수동 스냅샷 — 사용자가 보행 중 맨홀/계단/에스컬레이터/웅덩이/싱크홀 등을
// 직접 발견했을 때 사진 또는 짧은 동영상으로 기록한다(2026-09-26). 자동 탐지(open-set
// 큐)와 달리 사용자가 라벨을 직접 붙이므로 정확도가 훨씬 높은 라벨링 데이터가 된다 —
// 나중에 이 데이터로 맨홀/계단/에스컬레이터 전용 탐지 모델을 만들 때 쓴다.
//
// 저장은 하지 않는다(dataManager가 담당) — 이 클래스는 순수하게 "현재 비디오에서
// 사진/동영상을 뽑아내는" 역할만 한다. 기존 unknownObjectExporter.js/plateScanManager.js와
// 같은 원칙: 서버 업로드 없음, 전부 로컬에서만 처리.
const VIDEO_DURATION_MS = 5000;

export class HazardSnapshotRecorder {
    constructor(video) {
        this.video = video;
    }

    // 현재 프레임을 네이티브 해상도 그대로 JPEG dataURL로.
    capturePhoto(category) {
        const canvas = document.createElement('canvas');
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        canvas.getContext('2d').drawImage(this.video, 0, 0);
        return {
            category,
            mediaType: 'photo',
            dataUrl: canvas.toDataURL('image/jpeg', 0.85)
        };
    }

    // 카메라 스트림에서 VIDEO_DURATION_MS만큼 녹화 — 에스컬레이터 방향/계단 오르내림처럼
    // 정지 사진 한 장으론 판단 안 되는 대상을 위해 정지 사진과 별도로 제공한다.
    async recordVideo(category) {
        const stream = this.video.srcObject;
        if (!stream) throw new Error('카메라 스트림이 없습니다');

        // 오디오 트랙 없이 비디오만 — 마이크 권한/사용을 이 기능 때문에 새로 요구하지 않는다.
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
            ? 'video/webm;codecs=vp8'
            : 'video/webm';
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

        const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.start();
        await new Promise((resolve) => setTimeout(resolve, VIDEO_DURATION_MS));
        recorder.stop();
        await stopped;

        return {
            category,
            mediaType: 'video',
            blob: new Blob(chunks, { type: mimeType }),
            mimeType
        };
    }
}

export { VIDEO_DURATION_MS };
