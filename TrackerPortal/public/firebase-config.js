// Copy your Firebase web config from the console and replace these placeholders.
export const firebaseConfig = {
  apiKey: "AIzaSyCMy6XXX2r5gutvqymecbinONj0ZYX0Heg",
  authDomain: "wurdemaniot.firebaseapp.com",
  projectId: "wurdemaniot",
  storageBucket: "wurdemaniot.firebasestorage.app",
  messagingSenderId: "326690015446",
  appId: "1:326690015446:web:d298e396baa08a71d9e177",
  measurementId: "G-L4PVSKNPXC"
};

// Device ingest settings (keep this token private).
export const ingestConfig = {
  url: "https://us-central1-wurdemaniot.cloudfunctions.net/ingest",
  deviceId: "Tyee",
  deviceToken: "b7c9e2a41fd64e7d9f13c8a5",
  thermostatId: "home"
};
