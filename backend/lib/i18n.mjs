// Hindi i18n strings — used for patient-side UI + reports.
// Doctor UI stays English; patient UI auto-translates key strings.
// For full coverage use proper i18n library; this is a lightweight dict.

const HI = {
  // Common
  app_name: 'तत्वकेयर',
  loading: 'लोड हो रहा है...',
  save: 'सहेजें',
  cancel: 'रद्द करें',
  yes: 'हाँ',
  no: 'नहीं',
  back: 'वापस',
  next: 'अगला',
  done: 'पूरा हुआ',
  error: 'त्रुटि',
  close: 'बंद करें',

  // Login / auth
  login_title: 'अपना खाता खोलें',
  login_phone_or_email: 'फ़ोन या ईमेल',
  login_password: 'पासवर्ड',
  login_button: 'लॉगिन',
  login_failed: 'लॉगिन विफल — कृपया जाँचें',
  logout: 'लॉग आउट',
  welcome: 'स्वागत है',

  // Patient home
  patient_home_title: 'मेरा स्वास्थ्य',
  upcoming_appointments: 'आगामी अपॉइंटमेंट',
  active_medications: 'चालू दवाइयाँ',
  recent_lab_results: 'हाल की जांच रिपोर्ट',
  no_appointments: 'कोई आगामी अपॉइंटमेंट नहीं',
  no_medications: 'कोई चालू दवाई नहीं',
  no_labs: 'कोई हाल की जांच नहीं',

  // Vitals
  vitals_title: 'मेरे वाइटल्स',
  vitals_log_title: 'घर पर मापी गई रीडिंग दर्ज करें',
  vitals_log_subtitle: 'नीचे अपनी रीडिंग दर्ज करें। डॉक्टर अगली विज़िट पर देखेंगे।',
  metric_bp_systolic: 'रक्तचाप (सिस्टोलिक) mmHg',
  metric_bp_diastolic: 'रक्तचाप (डायस्टोलिक) mmHg',
  metric_pulse: 'नाड़ी / पल्स',
  metric_glucose_fasting: 'खाली पेट शुगर (FBS) mg/dL',
  metric_glucose_pp: 'भोजन के बाद शुगर (PPBS) mg/dL',
  metric_weight_kg: 'वज़न (kg)',
  metric_temp_c: 'तापमान (°C)',
  metric_spo2: 'SpO2 (%)',
  record_value: 'रीडिंग दर्ज करें',
  recorded_at: 'कब ली',
  high_value: '⚠️ यह मान सामान्य से अधिक है',
  low_value: '⚠️ यह मान सामान्य से कम है',
  saved_successfully: 'रीडिंग सफलतापूर्वक सहेजी गई',

  // Prescriptions
  my_prescriptions: 'मेरी दवाइयाँ',
  rx_label: 'नुस्खा',
  rx_doctor: 'डॉक्टर',
  rx_date: 'तारीख',
  rx_diagnosis: 'निदान',
  rx_advice: 'सलाह',
  rx_followup: 'अगली विज़िट',
  no_prescriptions: 'कोई नुस्खा नहीं',

  // Reminders
  reminders_title: 'रिमाइंडर',
  reminder_med: 'दवाई लें: ',
  reminder_appt: 'अपॉइंटमेंट: ',
  reminder_lab: 'जांच करवाएं: ',
  reminder_followup: 'फॉलो-अप: ',
  no_reminders: 'कोई रिमाइंडर नहीं',

  // Telemedicine
  tele_title: 'टेलीमेडिसिन विज़िट',
  tele_join: 'कॉल में शामिल हों',
  tele_end: 'कॉल समाप्त करें',
  tele_mute: 'म्यूट',
  tele_unmute: 'अनम्यूट',
  tele_camera_on: 'कैमरा चालू',
  tele_camera_off: 'कैमरा बंद',

  // Errors
  err_network: 'नेटवर्क त्रुटि — कृपया फिर से कोशिश करें',
  err_unauthorized: 'आपको अनुमति नहीं है',

  // Reminders by channel
  sent_whatsapp: 'WhatsApp पर भेजा गया',
  sent_sms: 'SMS पर भेजा गया',

  // Welcome message
  patient_welcome: 'आपका स्वास्थ्य, आपकी उँगलियों पर',
};

// English fallback
const EN = Object.fromEntries(Object.keys(HI).map(k => [k, k]));

let _current = 'en';
function setLocale(loc) { _current = (loc === 'hi' ? 'hi' : 'en'); }
function getLocale() { return _current; }
function t(key, opts = {}) {
  let s = _current === 'hi' ? HI[key] : EN[key];
  if (s === undefined) s = key;
  if (opts.values) {
    for (const [k, v] of Object.entries(opts.values)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}

// Quick Hindi translation for free-form English text via simple dictionary fallback.
// For production: use a translation API. Here we provide a small common-term map.
const EN_TO_HI = {
  'patient': 'रोगी', 'doctor': 'डॉक्टर', 'appointment': 'अपॉइंटमेंट',
  'medicine': 'दवाई', 'medication': 'दवाई', 'prescription': 'नुस्खा',
  'follow-up': 'फॉलो-अप', 'followup': 'फॉलो-अप', 'lab': 'जांच',
  'report': 'रिपोर्ट', 'vital': 'वाइटल', 'reading': 'रीडिंग',
  'high': 'उच्च', 'low': 'कम', 'normal': 'सामान्य',
  'abnormal': 'असामान्य', 'critical': 'गंभीर',
  'today': 'आज', 'tomorrow': 'कल', 'yesterday': 'कल',
  'good': 'अच्छा', 'bad': 'खराब', 'warning': 'चेतावनी',
  'high blood pressure': 'उच्च रक्तचाप', 'low blood pressure': 'कम रक्तचाप',
  'sugar': 'शुगर', 'diabetes': 'मधुमेह', 'fever': 'बुखार',
  'pain': 'दर्द', 'cough': 'खांसी', 'cold': 'सर्दी',
  'headache': 'सिरदर्द', 'nausea': 'मतली', 'vomiting': 'उल्टी',
  'diarrhea': 'दस्त', 'constipation': 'कब्ज़',
  'chest pain': 'सीने में दर्द', 'breathlessness': 'साँस लेने में कठिनाई',
  'fatigue': 'थकान', 'weakness': 'कमज़ोरी',
  'continue': 'जारी रखें', 'stop': 'रोकें', 'start': 'शुरू करें',
  'before breakfast': 'खाने से पहले', 'after breakfast': 'नाश्ते के बाद',
  'before dinner': 'रात के खाने से पहले', 'after dinner': 'रात के खाने के बाद',
  'with food': 'खाने के साथ', 'empty stomach': 'खाली पेट',
  'twice a day': 'दिन में दो बार', 'three times a day': 'दिन में तीन बार',
  'once a day': 'दिन में एक बार', 'at bedtime': 'सोने से पहले',
};

function translateText(text) {
  if (_current !== 'hi' || !text) return text;
  let out = text;
  // Replace longer phrases first
  const keys = Object.keys(EN_TO_HI).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\b`, 'gi');
    out = out.replace(re, EN_TO_HI[k]);
  }
  return out;
}

export { setLocale, getLocale, t, translateText, HI, EN };
