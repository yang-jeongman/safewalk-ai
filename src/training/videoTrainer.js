// 실제 영상 학습 모듈
export class VideoTrainer {
    constructor() {
        this.frames = [];
        this.labels = [];
        this.model = null;
        this.db = null;
        this.initDB();
    }

    async initDB() {
        // IndexedDB 초기화
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('WalkingTrainingDB', 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains('trainingFrames')) {
                    const store = db.createObjectStore('trainingFrames', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    store.createIndex('label', 'label', { unique: false });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }

                if (!db.objectStoreNames.contains('models')) {
                    db.createObjectStore('models', { keyPath: 'name' });
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('Training DB 초기화 완료');
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    // 비디오에서 프레임 추출 및 라벨링
    async extractFramesFromVideo(videoFile, label, frameInterval = 30) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            video.src = URL.createObjectURL(videoFile);
            video.muted = true;

            let frameCount = 0;
            let extractedFrames = 0;

            video.addEventListener('loadedmetadata', () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                video.play();
            });

            video.addEventListener('play', () => {
                const extractFrame = () => {
                    if (video.paused || video.ended) {
                        URL.revokeObjectURL(video.src);
                        resolve(extractedFrames);
                        return;
                    }

                    frameCount++;

                    // 지정된 간격마다 프레임 추출
                    if (frameCount % frameInterval === 0) {
                        ctx.drawImage(video, 0, 0);

                        canvas.toBlob(async (blob) => {
                            await this.saveFrame(blob, label);
                            extractedFrames++;

                            console.log(`프레임 추출: ${videoFile.name} - ${extractedFrames}번째`);
                        }, 'image/jpeg', 0.8);
                    }

                    requestAnimationFrame(extractFrame);
                };

                extractFrame();
            });

            video.addEventListener('error', reject);
        });
    }

    // 프레임 저장
    async saveFrame(blob, label) {
        const transaction = this.db.transaction(['trainingFrames'], 'readwrite');
        const store = transaction.objectStore('trainingFrames');

        const frameData = {
            image: blob,
            label: label,
            timestamp: Date.now(),
            size: blob.size
        };

        return new Promise((resolve, reject) => {
            const request = store.add(frameData);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // 저장된 프레임으로 학습
    async trainWithStoredFrames() {
        const transaction = this.db.transaction(['trainingFrames'], 'readonly');
        const store = transaction.objectStore('trainingFrames');

        const frames = await this.getAllFrames(store);
        console.log(`총 ${frames.length}개 프레임으로 학습 시작`);

        // 라벨별 분류
        const labeledData = {};
        frames.forEach(frame => {
            if (!labeledData[frame.label]) {
                labeledData[frame.label] = [];
            }
            labeledData[frame.label].push(frame);
        });

        // Transfer Learning with MobileNet
        await this.performTransferLearning(labeledData);
    }

    // Transfer Learning 실행
    async performTransferLearning(labeledData) {
        try {
            // MobileNet 로드
            const mobilenet = await tf.loadLayersModel(
                'https://tfhub.dev/google/tfjs-model/imagenet/mobilenet_v2_100_224/feature_vector/3/default/1'
            );

            // 새로운 분류 레이어 추가
            const model = tf.sequential({
                layers: [
                    tf.layers.dense({
                        inputShape: [1280], // MobileNet v2 출력 크기
                        units: 128,
                        activation: 'relu'
                    }),
                    tf.layers.dropout({ rate: 0.2 }),
                    tf.layers.dense({
                        units: Object.keys(labeledData).length,
                        activation: 'softmax'
                    })
                ]
            });

            // 컴파일
            model.compile({
                optimizer: tf.train.adam(0.0001),
                loss: 'categoricalCrossentropy',
                metrics: ['accuracy']
            });

            // 학습 데이터 준비
            const { xs, ys } = await this.prepareTrainingData(labeledData, mobilenet);

            // 학습 실행
            const history = await model.fit(xs, ys, {
                epochs: 20,
                batchSize: 32,
                validationSplit: 0.2,
                callbacks: {
                    onEpochEnd: (epoch, logs) => {
                        console.log(`Epoch ${epoch + 1}: loss=${logs.loss.toFixed(4)}, accuracy=${logs.acc.toFixed(4)}`);
                    }
                }
            });

            // 모델 저장
            await this.saveModel(model, 'walking-safety-model');

            return model;
        } catch (error) {
            console.error('Transfer Learning 실패:', error);
            throw error;
        }
    }

    // 학습 데이터 준비
    async prepareTrainingData(labeledData, featureExtractor) {
        const labels = Object.keys(labeledData);
        const images = [];
        const targets = [];

        for (let labelIdx = 0; labelIdx < labels.length; labelIdx++) {
            const label = labels[labelIdx];
            const frames = labeledData[label];

            for (const frame of frames) {
                // Blob을 이미지로 변환
                const img = await this.blobToImage(frame.image);
                const tensor = tf.browser.fromPixels(img)
                    .resizeNearestNeighbor([224, 224])
                    .toFloat()
                    .div(tf.scalar(255));

                // 특징 추출
                const features = featureExtractor.predict(tensor.expandDims());

                images.push(features);
                targets.push(labelIdx);

                tensor.dispose();
            }
        }

        // One-hot 인코딩
        const xs = tf.concat(images);
        const ys = tf.oneHot(targets, labels.length);

        return { xs, ys };
    }

    // Blob을 이미지로 변환
    blobToImage(blob) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = URL.createObjectURL(blob);
        });
    }

    // 모든 프레임 가져오기
    getAllFrames(store) {
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // 모델 저장
    async saveModel(model, name) {
        // IndexedDB에 모델 저장
        await model.save(`indexeddb://${name}`);

        // 메타데이터 저장
        const transaction = this.db.transaction(['models'], 'readwrite');
        const store = transaction.objectStore('models');

        await store.put({
            name: name,
            timestamp: Date.now(),
            version: '1.0'
        });

        console.log(`모델 저장 완료: ${name}`);
    }

    // 모델 로드
    async loadModel(name) {
        try {
            this.model = await tf.loadLayersModel(`indexeddb://${name}`);
            console.log(`모델 로드 완료: ${name}`);
            return this.model;
        } catch (error) {
            console.error('모델 로드 실패:', error);
            return null;
        }
    }

    // 학습 데이터 통계
    async getTrainingStats() {
        const transaction = this.db.transaction(['trainingFrames'], 'readonly');
        const store = transaction.objectStore('trainingFrames');
        const frames = await this.getAllFrames(store);

        const stats = {};
        frames.forEach(frame => {
            if (!stats[frame.label]) {
                stats[frame.label] = 0;
            }
            stats[frame.label]++;
        });

        return {
            totalFrames: frames.length,
            labels: Object.keys(stats),
            distribution: stats
        };
    }

    // 데이터 내보내기
    async exportTrainingData() {
        const frames = await this.getAllFrames(
            this.db.transaction(['trainingFrames'], 'readonly').objectStore('trainingFrames')
        );

        // ZIP 파일 생성 (JSZip 라이브러리 필요)
        const zip = new JSZip();

        for (const frame of frames) {
            const folder = zip.folder(frame.label);
            folder.file(`frame_${frame.id}.jpg`, frame.image);
        }

        // 메타데이터 추가
        const metadata = {
            totalFrames: frames.length,
            labels: [...new Set(frames.map(f => f.label))],
            exportDate: new Date().toISOString()
        };

        zip.file('metadata.json', JSON.stringify(metadata, null, 2));

        // 다운로드
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `training_data_${Date.now()}.zip`;
        a.click();

        URL.revokeObjectURL(url);
    }

    // 데이터 초기화
    async clearTrainingData() {
        const transaction = this.db.transaction(['trainingFrames'], 'readwrite');
        const store = transaction.objectStore('trainingFrames');
        await store.clear();
        console.log('학습 데이터 초기화 완료');
    }
}