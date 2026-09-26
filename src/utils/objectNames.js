// 객체 클래스명 → 한글 표시명 공용 매핑.
// warningSystem.js(음성 안내)와 uiController.js(리포트 화면)가 각자 따로 들고 있다가
// 리포트 쪽이 갱신을 안 따라가서 "pole"/"obstacle"/"bench"가 번역 안 된 채 그대로
// 노출된 실측 버그(2026-09-26, 리포트 화면 "자주 감지된 물체")가 있었다 — 하나로 합친다.
export const OBJECT_NAMES = {
    'car': '자동차',
    'bus': '버스',
    'truck': '트럭',
    'motorcycle': '오토바이',
    'bicycle': '자전거',
    'person': '사람',
    'traffic light': '신호등',
    'stop sign': '정지 표지판',
    'unknown': '정체불명의 물체', // Phase 2 open-set 인식 결과
    'obstacle': '장애물', // 벽/기둥 등 COCO-SSD가 모르는 정면 장애물 (모션게이트 합성)
    'pole': '기둥', // 전봇대/기둥 (기둥게이트 합성)
    'bench': '벤치',
    'manhole': '맨홀', // open-set 갤러리 항목 (2026-09-18)
    'bollard': '볼라드',
    'crosswalk': '횡단보도' // onnxCrosswalkDetector.js (2026-09-26)
};
