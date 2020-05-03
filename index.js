var os = require('os');
var fs = require("fs");
var rtp = require("./rtp.js");
var rtcp = require("./rtcp.js");
var EventEmitter = require('eventemitter3');
var util = require('util');
var uuidParse = require('uuid-parse');

var PT_STATUS = 100;
var PT_CMD = 101;
var PT_FILE = 102;
var PT_CAM_BASE = 110;
var PT_AUDIO_BASE = 120;

function encodeHTML(str) {
	return str.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
function decodeHTML(str) {
	return str.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');
 }
class Picam360Capture extends EventEmitter {
	constructor() {
		super();
		var self = this;
		self.cmd_list = [];
		self.watches = [];
		self.rtcp_command_id = 0;
		// handling data from picam360-capture
		rtp
			.set_callback(9004, function(pack) {
				var sequencenumber = pack.GetSequenceNumber();
				if(rtp.last_sequencenumber + 1 != sequencenumber){
					console.log("packet lost : " + rtp.last_sequencenumber + " - " + sequencenumber);
				}
				rtp.last_sequencenumber = sequencenumber;
				if (pack.GetPayloadType() == PT_STATUS) {
					var data_len = pack.GetPacketLength();
					var header_len = pack.GetHeaderLength();
					var data = pack.GetPacketData();
					var start = 0;
					var start_code = '<'.charCodeAt(0);
					var end_code = '>'.charCodeAt(0);
					for (var j = header_len; j < data_len; j++) {
						if (data[j] == start_code) {
							start = j;
						} else if (data[j] == end_code) {
							var str = String.fromCharCode.apply("", data
								.subarray(start, j + 1), 0);
							var name;
							var value;
							var last_spece = -1;
							var first_dq = -1;
							for (var i = 0; i < str.length; i++) {
								if (first_dq < 0 && str[i] == ' ') {
									last_spece = i;
								} else if (str[i] == '\"') {
									if (first_dq < 0) {
										first_dq = i;
									} else {
										var tag = str
											.slice(last_spece + 1, first_dq - 1);
										if (tag == "name") {
											name = decodeHTML(str
												.slice(first_dq + 1, i));
										} else if (tag == "value") {
											value = decodeHTML(str
												.slice(first_dq + 1, i));
										}
										last_spece = -1;
										first_dq = -1;
									}
								}
							}
							if (name) {
								if(self.watches[name] && self.watches[name] != value){
									self.emit(name + "_changed", value);
								}
								self.watches[name] = value;
							}
						}
					}
				} else if (pack.GetPayloadType() == PT_AUDIO_BASE) {
					var data = pack.GetPacketData();
				}
			});
		// cmd to picam360-capture
		{ // reset ack_command_id
			var cmd = "<picam360:command id=\"0\" value=\"\" />";
			var pack = rtcp
				.build_packet(Buffer.from(cmd, 'ascii'), PT_CMD);
			rtcp.sendpacket(pack, 9005, "127.0.0.1");
		}
		setInterval(function() {
			if (self.cmd_list.length) {
				var value = self.cmd_list.shift();
				var cmd = "<picam360:command id=\"" + (++self.rtcp_command_id) +
					"\" value=\"" + encodeHTML(value) + "\" />";
				var pack = rtcp
					.build_packet(Buffer.from(cmd, 'ascii'), PT_CMD);
				rtcp.sendpacket(pack, 9005, "127.0.0.1");
			}
		}, 20);
	}
	send_command(value) {
		this.cmd_list.push(value);
	}
	get_status(name) {
		return this.watches[name];
	}
}
module.exports = Picam360Capture;