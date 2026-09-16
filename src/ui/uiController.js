// UI 컨트롤러 모듈
export class UIController {
    constructor() {
        this.currentScreen = 'main';
        this.screens = {};
        this.dangerLevelElement = null;
    }

    init() {
        // 모든 화면 요소 캐싱
        this.screens = {
            splash: document.getElementById('splash'),
            main: document.getElementById('main'),
            walking: document.getElementById('walking'),
            settings: document.getElementById('settings')
        };

        // 위험도 표시 요소
        this.dangerLevelElement = document.getElementById('dangerLevel');

        // 설정 이벤트 바인딩
        this.bindSettingsEvents();
    }

    switchScreen(screenName) {
        // 현재 화면 숨기기
        if (this.screens[this.currentScreen]) {
            this.screens[this.currentScreen].classList.remove('active');
        }

        // 새 화면 표시
        if (this.screens[screenName]) {
            this.screens[screenName].classList.add('active');
            this.currentScreen = screenName;
        }

        // 네비게이션 업데이트
        this.updateNavigation(screenName);
    }

    updateNavigation(screenName) {
        // 네비게이션 아이템 업데이트
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.screen === screenName) {
                item.classList.add('active');
            }
        });
    }

    updateStatus(type, data) {
        switch (type) {
            case 'walking':
                if (data.status === 'active') {
                    document.querySelector('.status-icon').textContent = '🔴';
                    document.querySelector('.status-text').textContent = '보행 감지 중';
                    document.querySelector('.walking-indicator').textContent = '● 감지중';
                } else {
                    document.querySelector('.status-icon').textContent = '🟢';
                    document.querySelector('.status-text').textContent = '안전 모드 대기중';
                }
                break;
        }
    }

    showAlert(message, type = 'info') {
        const alert = document.createElement('div');
        alert.className = `system-alert ${type}`;
        alert.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#2196F3'};
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 10000;
            animation: slideDown 0.3s ease;
        `;
        alert.textContent = message;

        document.body.appendChild(alert);

        setTimeout(() => {
            alert.style.animation = 'slideUp 0.3s ease';
            setTimeout(() => alert.remove(), 300);
        }, 3000);
    }

    showDanger(threat) {
        this.updateDangerLevel(threat.level);

        // 위험 정보 표시
        const alertZone = document.getElementById('alertZone');
        if (!alertZone) return;

        const alert = document.createElement('div');
        alert.className = 'alert danger';
        alert.innerHTML = `
            <strong>⚠️ 위험!</strong><br>
            ${threat.direction} ${threat.class}<br>
            거리: ${threat.distance.toFixed(1)}m
        `;

        alertZone.innerHTML = '';
        alertZone.appendChild(alert);
        alertZone.classList.add('active');

        // 3초 후 제거
        setTimeout(() => {
            alert.remove();
            if (alertZone.children.length === 0) {
                alertZone.classList.remove('active');
            }
        }, 3000);
    }

    showWarning(threat) {
        this.updateDangerLevel(threat.level);

        const alertZone = document.getElementById('alertZone');
        if (!alertZone) return;

        const alert = document.createElement('div');
        alert.className = 'alert warning';
        alert.innerHTML = `
            <strong>주의</strong><br>
            ${threat.direction} ${threat.class}
        `;

        alertZone.innerHTML = '';
        alertZone.appendChild(alert);
        alertZone.classList.add('active');

        setTimeout(() => {
            alert.remove();
            if (alertZone.children.length === 0) {
                alertZone.classList.remove('active');
            }
        }, 2000);
    }

    updateDangerLevel(level) {
        if (!this.dangerLevelElement) return;

        const percentage = Math.min(100, Math.round(level * 100));
        const fillElement = this.dangerLevelElement.querySelector('.level-fill');
        const textElement = this.dangerLevelElement.querySelector('.level-text');

        // 위험도 바 업데이트
        fillElement.style.width = `${percentage}%`;

        // 색상 변경
        let color = '#4CAF50'; // 녹색
        let text = '안전';

        if (level > 0.7) {
            color = '#f44336'; // 빨강
            text = '위험';
        } else if (level > 0.4) {
            color = '#ff9800'; // 주황
            text = '주의';
        }

        fillElement.style.backgroundColor = color;
        textElement.textContent = text;
    }

    bindSettingsEvents() {
        // 음성 경고 설정
        const voiceAlert = document.getElementById('voiceAlert');
        if (voiceAlert) {
            voiceAlert.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                localStorage.setItem('voiceAlert', enabled);
            });

            // 저장된 설정 로드
            const saved = localStorage.getItem('voiceAlert');
            if (saved !== null) {
                voiceAlert.checked = saved === 'true';
            }
        }

        // 진동 경고 설정
        const vibrationAlert = document.getElementById('vibrationAlert');
        if (vibrationAlert) {
            vibrationAlert.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                localStorage.setItem('vibrationAlert', enabled);
            });

            const saved = localStorage.getItem('vibrationAlert');
            if (saved !== null) {
                vibrationAlert.checked = saved === 'true';
            }
        }

        // 민감도 설정
        const sensitivity = document.getElementById('sensitivity');
        if (sensitivity) {
            sensitivity.addEventListener('change', (e) => {
                const value = e.target.value;
                localStorage.setItem('sensitivity', value);
            });

            const saved = localStorage.getItem('sensitivity');
            if (saved) {
                sensitivity.value = saved;
            }
        }

        // 이모지 투명도 (감지 결과를 원본 영상 대신 이모지로만 표시)
        const emojiOpacity = document.getElementById('emojiOpacity');
        if (emojiOpacity) {
            emojiOpacity.addEventListener('input', (e) => {
                localStorage.setItem('emojiOpacity', e.target.value);
            });

            const saved = localStorage.getItem('emojiOpacity');
            if (saved) {
                emojiOpacity.value = saved;
            }
        }

        // 미지 객체 학습 참여 (Phase 2 open-set 인식, 기본값 OFF)
        const unknownObjectContribution = document.getElementById('unknownObjectContribution');
        if (unknownObjectContribution) {
            unknownObjectContribution.addEventListener('change', (e) => {
                localStorage.setItem('unknownObjectContribution', String(e.target.checked));
            });

            unknownObjectContribution.checked = localStorage.getItem('unknownObjectContribution') === 'true';
        }
    }

    // 통계 표시 업데이트
    updateStats(stats) {
        // 안전 점수
        const scoreElement = document.getElementById('safetyScore');
        if (scoreElement && stats.safetyScore !== undefined) {
            scoreElement.textContent = stats.safetyScore;
        }

        // 보행 시간
        const walkTimeElement = document.getElementById('walkTime');
        if (walkTimeElement && stats.walkTime !== undefined) {
            walkTimeElement.textContent = stats.walkTime;
        }

        // 위험 감지 횟수
        const dangerCountElement = document.getElementById('dangerCount');
        if (dangerCountElement && stats.dangerCount !== undefined) {
            dangerCountElement.textContent = stats.dangerCount;
        }
    }

    // 로딩 표시
    showLoading(show = true) {
        const loading = document.querySelector('.loading-spinner');
        if (loading) {
            loading.style.display = show ? 'block' : 'none';
        }
    }
}