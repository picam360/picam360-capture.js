var Picam360Capture = require('./index.js');

var picam360_capture = new Picam360Capture();

picam360_capture.on("ack_command_id_changed", (value) => {
	console.log("ack_command_id_changed : " + value);
})
setTimeout(() => {
	picam360_capture.send_command("<'test1'>");
}, 1000);
setTimeout(() => {
	picam360_capture.send_command('<"test2">');
}, 2000);