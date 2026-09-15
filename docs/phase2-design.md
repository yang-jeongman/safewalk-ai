# Phase 2 설계 — Open-set 객체 인식 (2026-09-15)

AI_개발위임_브리프.md §3.2, §5 Phase 2에 따라 구현 전 정리한 설계. 사용자 승인 후 구현 시작.

## 문제

COCO-SSD는 80개 클래스 폐쇄형(closed-set) 탐지기라서, 훈련되지 않은 객체(맨홀, 볼라드,
웅덩이 등 `walking_safety_objects.md`의 다수 항목)는 애초에 박스 자체를 만들지 않을 수 있다.
"임베딩으로 알려진/미지 구분"이 작동하려면 먼저 후보 영역(region proposal)이 있어야 한다.

## MVP 범위 (사용자 결정)

1차는 **COCO-SSD가 이미 만든 박스만 재활용**한다. COCO-SSD가 박스조차 안 만드는 완전
미탐지 물체(모션게이트 blob 기반 region proposal 등)는 Phase 2.5/3으로 미룬다 — 범위를
단순하게 유지하고 실측 가능하게 하기 위함.

## 판정 흐름

1. COCO-SSD 탐지 결과 중 `score >= lowConfidenceThreshold`(기본 0.6)인 박스는 기존처럼
   그대로 신뢰 (임베딩 계산 안 함 — 비용 절감).
2. `score < lowConfidenceThreshold`인 박스만 재검증 대상:
   - 박스 영역을 비디오에서 크롭 → MobileNet(v2) 임베딩(1024차원) 추출
   - 알려진 객체 갤러리(카테고리별 참조 임베딩)와 코사인 유사도 비교
   - 최고 유사도 >= `knownSimilarityThreshold`(기본 0.7, 실측 후 조정) → 해당 카테고리로 라벨 교체
   - 미만 → `class: 'unknown'`, 기본 위협도 0.5 (사람과 동급 — 안전 원칙상 "미지 = 저위험"
     취급 금지)
3. 이후 위협도 계산·시각화는 기존 `analyzeThreats`/`visualizePredictions` 그대로 재사용.

## 임베딩 모델

`@tensorflow-models/mobilenet` (v2, alpha 1.0) — 이유:
- 이미 TF.js 스택 위, 새 런타임 불필요
- ~10-15MB, 온디바이스 추론 빠름 (COCO-SSD와 비슷한 무게)
- CLIP류(의미론적으로 더 풍부하지만 40-100MB+)는 이미 5-50fps로 빠듯한 이 기기들엔 과함 —
  Phase 1 실측에서 확인된 성능 여유가 근거

## 알려진 객체 갤러리

`data/known-objects-gallery.json` — `{ category, threatLevel, embedding }[]` 구조.
**현재 참조 이미지가 하나도 없어 빈 배열로 시작** — 처음엔 전부 미지로 판정된다. 이후
라벨링 큐를 통해 점진적으로 채워진다. `walking_safety_objects.md` 50종이 카테고리 시드.

## 등록 경로 (서버 라벨링 큐 — 설계만, 업로드 트랜스포트는 이번 구현 범위 밖)

프로젝트에 백엔드가 전혀 없어(순수 정적 GitHub Pages) 새 인프라를 최소화하는 방향:

1. **클라이언트 전처리(프라이버시, 브리프 GDPR/PIPA 지적사항 반영)**:
   - 바운딩박스만 크롭(전체 프레임 전송 안 함), 작은 고정 크기로 축소
   - **기본값 OFF, 명시적 옵트인 필요** (설정 화면 체크박스)
   - 세션당 업로드 개수 제한
2. **전송**: 클라이언트에 쓰기 토큰을 직접 넣으면 탈취 위험 → 업로드만 중계하는 서버리스
   프록시(예: Cloudflare Worker, 무료 티어) 필요. **새 클라우드 계정 생성은 사용자 확인 후
   진행** — 이번 구현에서는 로컬 큐(localStorage, 최대 20개)까지만 만들고 실제 전송은
   TODO로 남긴다.
3. **라벨링**: 개발자가 수동으로 크롭 검토 → 카테고리 라벨 부여
4. **배포**: 라벨링 결과를 `known-objects-gallery.json`으로 만들어 레포에 커밋 → 앱이 fetch

## 실측 필요 항목 (Phase 1과 동일 원칙)

- `lowConfidenceThreshold`, `knownSimilarityThreshold` — 갤러리에 실제 데이터가 쌓인 뒤
  실측 기반으로 조정 필요. 지금은 근거 있는 초기값일 뿐.
- MobileNet 임베딩 추론이 이미 빠듯한 기기 성능에 미치는 영향 — 저confidence 박스에서만
  실행하도록 이미 제한했지만, 사이클당 처리 개수 상한(`maxEmbeddingChecksPerCycle`)도
  실측 후 조정.
