const int RELAY_PIN = 2;

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);   // cut power
}

void loop() {
  // nothing needed – relay stays off
}