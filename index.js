process.chdir(__dirname);
var os = require('os');
var async = require('async');
var fs = require("fs");
var moment = require("moment");
var sprintf = require('sprintf-js').sprintf;
var rtp = require("./rtp.js");
var rtcp = require("./rtcp.js");
var uuidgen = require('uuid/v4');
var EventEmitter = require('eventemitter3');
var util = require('util');
var uuidParse = require('uuid-parse');

var UPSTREAM_DOMAIN = "upstream.";
var SERVER_DOMAIN = "";
var CAPTURE_DOMAIN = UPSTREAM_DOMAIN;
var DRIVER_DOMAIN = UPSTREAM_DOMAIN + UPSTREAM_DOMAIN;
var PT_STATUS = 100;
var PT_CMD = 101;
var PT_FILE = 102;
var PT_CAM_BASE = 110;
var PT_AUDIO_BASE = 120;
var OSTREAM_PORT_START = 9100;
var OSTREAM_PORT_END = 9199;

function watchFile(filepath, oncreate, ondelete) {
	var fs = require('fs'),
		path = require('path'),
		filedir = path
		.dirname(filepath),
		filename = path.basename(filepath);
	fs.watch(filedir, function(event, who) {
		if (event === 'rename' && who === filename) {
			if (fs.existsSync(filepath)) {
				if (oncreate)
					oncreate();
			} else {
				if (ondelete)
					ondelete();
			}
		}
	});
}

function removeArray(array, value) {
	for (var i = array.length - 1; i >= 0; i--) {
		if (array[i] === value) {
			array.splice(i, 1);
		}
	}
}

function clone(src) {
	var dst = {}
	for (var k in src) {
		dst[k] = src[k];
	}
	return dst;
}

var plugin_host = {};
var plugins = [];
var rtp_rx_conns = [];
var cmd2upstream_list = [];
var cmd_list = [];
var watches = [];
var statuses = [];
var filerequest_list = [];
var m_port_index = 0;

var upstream_info = "";
var upstream_menu = "";
var upstream_quaternion = [0, 0, 0, 1.0];
var upstream_north = 0;

var is_recording = false;
var memoryusage_start = 0;
var GC_THRESH = 16 * 1024 * 1024; // 16MB
var capture_if;
var capture_process;
var m_request_call = "";
var m_audio_source = null;

var http = null;

var options = [];

async.waterfall([
	function(callback) {
		console.log("init data stream");

		var rtcp_command_id = 0;
		var active_frame = null;
		var startTime = new Date();
		var num_of_frame = 0;
		var fps = 0;

		rtp.send_error = function(conn, err) {
			setTimeout(function() {
				var name = "error";
				var value = err;
				var status = "<picam360:status name=\"" + name +
					"\" value=\"" + value + "\" />";
				var pack = rtp
					.build_packet(new Buffer(status, 'ascii'), PT_STATUS);
				rtp.sendpacket(conn, pack);
			}, 1000);
		}

		// parse status
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
											name = UPSTREAM_DOMAIN +
												str
												.slice(first_dq + 1, i);
										} else if (tag == "value") {
											value = str
												.slice(first_dq + 1, i);
										}
										last_spece = -1;
										first_dq = -1;
									}
								}
							}
							if (name && watches[name]) {
								watches[name](value);
							}
						}
					}
				} else if (pack.GetPayloadType() == PT_AUDIO_BASE) {
					var data = pack.GetPacketData();
					rtp.sendpacket_all(data);
				}
			});
		// cmd from downstream
		rtcp.set_callback(function(pack, conn) {
			if (pack.GetPayloadType() == PT_CMD) {
				var cmd = pack.GetPacketData().toString('ascii', pack
					.GetHeaderLength());
				var split = cmd.split('\"');
				var id = split[1];
				var value = split[3];
				plugin_host.send_command(value, conn);
				if (options.debug >= 5) {
					console.log("cmd got :" + cmd);
				}
			}
		});
		// cmd to upstream
		setInterval(function() {
			if (cmd2upstream_list.length) {
				var value = cmd2upstream_list.shift();
				var cmd = "<picam360:command id=\"" + (++rtcp_command_id) +
					"\" value=\"" + value + "\" />";
				var pack = rtcp
					.build_packet(new Buffer(cmd, 'ascii'), PT_CMD);
				rtcp.sendpacket(pack, 9005, "127.0.0.1");
			}
		}, 20);
		// status to downstream
		setInterval(function() {
			for (var i = rtp_rx_conns.length - 1; i >= 0; i--) {
				var conn = rtp_rx_conns[i];
				var pack_list = [];
				for (var name in statuses) {
					if (statuses[name]) {
						var ret = statuses[name](conn);
						if (!ret.succeeded) {
							continue;
						}
						var value = encodeURIComponent(ret.value);
						var status = "<picam360:status name=\"" + name +
							"\" value=\"" + value + "\" />";
						var pack = rtp
							.build_packet(new Buffer(status, 'ascii'), PT_STATUS);
						pack_list.push(pack);
					}
				}
				rtp.sendpacket(conn, pack_list);
			}
		}, 200);
		callback(null);
	},
	function(callback) {
		// plugin host
		var m_view_quaternion = [0, 0, 0, 1.0];
		setInterval(function() {
			if (cmd_list.length) {
				var cmd = cmd_list.shift();
				command_handler(cmd.value, cmd.conn);
			}
			if (filerequest_list.length) {
				var filerequest = filerequest_list.shift();
				filerequest_handler(filerequest.filename, filerequest.key, filerequest.conn);
			}
		}, 20);
		plugin_host.send_command = function(value, conn) {
			if (value.startsWith(UPSTREAM_DOMAIN)) {
				cmd2upstream_list
					.push(value.substr(UPSTREAM_DOMAIN.length));
			} else {
				cmd_list.push({
					value: value,
					conn: conn
				});
			}
		};
		plugin_host.get_vehicle_quaternion = function() {
			return upstream_quaternion;
		};
		plugin_host.get_vehicle_north = function() {
			return upstream_north;
		};
		plugin_host.get_view_quaternion = function() {
			return m_view_quaternion;
		};
		plugin_host.add_watch = function(name, callback) {
			watches[name] = callback;
		};
		plugin_host.add_status = function(name, callback) {
			statuses[name] = callback;
		};

		plugin_host.add_watch(UPSTREAM_DOMAIN + "quaternion", function(
			value) {
			var separator = (/[,]/);
			var split = value.split(separator);
			upstream_quaternion = [parseFloat(split[0]),
				parseFloat(split[1]), parseFloat(split[2]),
				parseFloat(split[3])
			];
		});

		plugin_host.add_watch(UPSTREAM_DOMAIN + "north", function(value) {
			upstream_north = parseFloat(value);
		});

		plugin_host.add_watch(UPSTREAM_DOMAIN + "info", function(value) {
			upstream_info = value;
		});

		plugin_host.add_watch(UPSTREAM_DOMAIN + "menu", function(value) {
			upstream_menu = value;
		});

		plugin_host.add_status("is_recording", function(conn) {
			return {
				succeeded: true,
				value: conn.frame_info.is_recording
			};
		});

		plugin_host.add_status("info", function() {
			return {
				succeeded: upstream_info != "",
				value: upstream_info
			};
		});

		plugin_host.add_status("menu", function() {
			return {
				succeeded: upstream_menu != "",
				value: upstream_menu
			};
		});

		// delete all frame
		var cmd = 'destroy_vstream -a';
		console.log(cmd);
		plugin_host.send_command(UPSTREAM_DOMAIN + cmd);

		callback(null);
	},
], function(err, result) {});