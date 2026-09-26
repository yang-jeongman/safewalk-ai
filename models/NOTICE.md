# 출처 및 라이선스 고지

이 폴더의 ONNX 모델은 아래 오픈소스 프로젝트의 학습된 가중치를 그대로 가져온 것입니다.
재학습이나 변형 없이 원본 그대로 사용합니다.

- 원본: [VRPDetectorKOR](https://github.com/HK416/VRPDetectorKOR) by HK416
- 라이선스: MIT License (Copyright (c) 2023 HK416)
- `plate_detect.onnx` = `yolov8n_plate_detect.onnx` (번호판 위치 검출, YOLOv8n)
  - 학습 데이터: [Roboflow model-plate 데이터셋](https://universe.roboflow.com/university-hassiba-ben-bouli/model-plate/dataset/6) (CC BY 4.0)
- `number_detect.onnx` = `yolov8m_number_detect.onnx` (번호판 글자 검출, YOLOv8m)
  - 학습 데이터: [AI Hub 자동차 번호판 인식용 영상](https://aihub.or.kr/aihubdata/data/view.do?currMenu=115&topMenu=100&aihubDataSe=realm&dataSetSn=172)

- 원본: [assistive-vision-ai](https://github.com/Ssevinc/assistive-vision-ai) by Seyyide Sevinc
- 라이선스: MIT License (Copyright (c) 2025 Seyyide Sevinc)
- `crosswalk_scene.onnx` = `models/best.onnx` (횡단보도·신호등 색 검출, YOLOv8n) —
  원본 8개 클래스(crosswalk/red_light/yellow_light/green_light/stairs/seating/shelter/
  trash_can) 중 crosswalk·신호등 3색만 사용
  - 학습 데이터: [Roboflow dataset-z6sm4](https://universe.roboflow.com/seyyide/dataset-z6sm4) (CC BY 4.0, 8,875장)

## 채택 이유 (2026-09-26) — 횡단보도 검출

번호판 위치 검출과 마찬가지로 COCO-SSD 80개 클래스엔 애초에 "횡단보도"가 없어 새
모델이 필요했다. 후보였던 kairess/crosswalk-traffic-light-detection-yolov5,
xN1ckuz/Crosswalks-Detection-using-YOLO는 성능(횡단보도 단독 mAP@.5 최대 0.988)은
더 높았지만 둘 다 ultralytics/yolov5를 통째로 포크해 **GPL-3.0**을 그대로 물려받고
있어 제외했다. assistive-vision-ai는 가중치·코드 모두 명시적으로 MIT이고 학습
데이터도 CC BY 4.0이라 라이선스가 깨끗하다(mAP50 0.91, 8개 클래스 평균). 신호등 색은
기존 `trafficLightColor.js`(HSV 히스토그램)와 별도 경로로 이 모델도 같이 판정해
서로 놓친 걸 보완하도록 했다 — 자세한 내용은 `src/detection/onnxCrosswalkDetector.js`
주석 참고.

## 채택 이유 (2026-09-20)

Tesseract.js(범용 OCR)를 AI Hub 공식 번호판 데이터셋 300장으로 검증한 결과 정확
일치율 2.7%에 그쳤다 — 특히 한글 글자를 거의 항상 틀리거나 빠뜨렸다. VRPDetectorKOR
원작자도 README에서 "한글 인식률이 높지 않다"고 직접 밝혔지만, 번호판 전용으로
학습된 모델이라 범용 OCR보다는 나을 것으로 판단해 채택했다. 자체 검증(글자 검출
모델, 정식 전처리 없이 20장 약식 테스트)에서 정확 일치 35%로 Tesseract 대비 크게
개선됨을 확인했다 — 다만 이것도 완벽과는 거리가 멀고, 특히 옛날식(지역명 포함) 번호판
형식은 이 모델이 학습하지 않은 형식이라 처리하지 못한다.

## MIT 라이선스 전문

```
MIT License

Copyright (c) 2023 HK416

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## assistive-vision-ai MIT 라이선스 전문

```
MIT License

Copyright (c) 2025 Seyyide Sevinc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
