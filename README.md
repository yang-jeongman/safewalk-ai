# SafeWalk AI - 안전 보행 앱

## 프로젝트 개요
스마트폰을 보며 걷는 보행자의 안전을 위한 AI 기반 실시간 위험 감지 및 경고 시스템

## 핵심 기능
- 실시간 전방 위험 객체 감지
- 음성/진동/시각 경고 시스템
- 보행 안전 점수 및 리포트
- PWA 기반 모바일 웹 앱

## 프로젝트 구조
```
LifeTimeBlackbox/
├── src/                # 소스 코드
│   ├── core/          # 핵심 비즈니스 로직
│   ├── detection/     # AI 객체 탐지 모듈
│   ├── warning/       # 경고 시스템 모듈
│   ├── ui/           # UI 컴포넌트
│   └── utils/        # 유틸리티 함수
├── data/             # 학습 및 테스트 데이터
│   ├── videos/       # 학습용 영상
│   └── labels/       # 라벨링 데이터
├── models/           # AI 모델 파일
├── docs/             # 문서
│   ├── api/         # API 문서
│   └── guides/      # 사용 가이드
├── public/           # 정적 파일
│   └── assets/      # 리소스 파일
│       ├── icons/   # 아이콘
│       └── sounds/  # 경고음
└── index.html       # 메인 진입점
```

## 기술 스택
- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **AI/ML**: TensorFlow.js, COCO-SSD
- **PWA**: Service Worker, Web Manifest
- **APIs**: MediaDevices, Web Speech, Vibration

## 개발 단계
### Phase 1: MVP (현재)
- [x] 프로젝트 구조 설계
- [ ] 위험 객체 정의 및 분류
- [ ] 실시간 객체 탐지
- [ ] 경고 시스템 구현
- [ ] 기본 UI 구현

### Phase 2: 개선
- [ ] 사용자 맞춤 설정
- [ ] 안전 점수 시스템
- [ ] 데이터 수집 및 학습

### Phase 3: 확장
- [ ] 보험사 연동
- [ ] 가족 알림 기능
- [ ] AR 가이드

## 설치 및 실행
```bash
# 로컬 서버 실행 (Live Server 확장 사용 권장)
# 또는 Python 서버
python -m http.server 8000
```

## 라이선스
MIT License

## 문의
프로젝트 관련 문의사항은 Issues 탭을 이용해주세요.